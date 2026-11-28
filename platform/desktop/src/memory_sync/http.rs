//! 跨设备记忆同步的 HTTP 客户端（Rust 侧发请求，WebView 的 CSP 因此不再需要放行 `https:`）。
//!
//! 约束：只允许 https（开发时允许 http://127.0.0.1 / localhost / [::1]）；连接 10 秒、整体 20 秒超时；
//! 只跟随同源重定向（最多 3 次），跨源重定向直接停下并按非 2xx 报错；响应体上限 8 MiB；
//! 令牌只放 Authorization 头（标记 sensitive），本类型不实现 Debug，错误信息不含 URL 和令牌。

use reqwest::{
    header::{HeaderValue, AUTHORIZATION, CONTENT_TYPE},
    redirect::Policy,
    Client, RequestBuilder, Url,
};
use serde::de::DeserializeOwned;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_REDIRECTS: usize = 3;
const MAX_BODY: usize = 8 * 1024 * 1024;
const LOOPBACK: [&str; 3] = ["127.0.0.1", "localhost", "[::1]"];

/// 校验并解析同步服务器地址。
pub fn parse_server(raw: &str) -> Result<Url, String> {
    let bad = || "同步服务器须为 https:// 地址".to_string();
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 512 || raw.contains(char::is_whitespace) {
        return Err(bad());
    }
    let url = Url::parse(raw).map_err(|_| bad())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(bad());
    }
    let host = url.host_str().unwrap_or_default();
    let ok = match url.scheme() {
        "https" => !host.is_empty(),
        "http" => LOOPBACK.contains(&host),
        _ => false,
    };
    ok.then_some(url).ok_or_else(bad)
}

/// 重定向策略（纯函数便于测试）：只允许同源且次数未超限。
pub fn redirect_allowed(base: &Url, next: &Url, followed: usize) -> bool {
    followed < MAX_REDIRECTS && base.origin() == next.origin()
}

pub fn endpoint(base: &Url, name: &str) -> Url {
    let mut url = base.clone();
    let path = format!("{}/v1/memory-sync/{name}", url.path().trim_end_matches('/'));
    url.set_path(&path);
    url
}

pub fn pull_url(base: &Url, workspace: &str, since: i64) -> Url {
    let mut url = endpoint(base, "changes");
    url.query_pairs_mut()
        .append_pair("workspace", workspace)
        .append_pair("since", &since.to_string());
    url
}

fn net_error(tag: &str, e: &reqwest::Error) -> String {
    let kind = if e.is_timeout() {
        "timeout"
    } else if e.is_connect() {
        "connect"
    } else if e.is_redirect() {
        "redirect"
    } else {
        "network"
    };
    format!("{tag}_{kind}")
}

pub struct Remote {
    client: Client,
    base: Url,
    auth: Option<HeaderValue>,
}

impl Remote {
    pub fn new(server: &str, token: &str) -> Result<Self, String> {
        let base = parse_server(server)?;
        let origin = base.clone();
        let client = Client::builder()
            .timeout(TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT)
            .https_only(base.scheme() == "https")
            .redirect(Policy::custom(move |a| {
                if redirect_allowed(&origin, a.url(), a.previous().len().saturating_sub(1)) {
                    a.follow()
                } else {
                    a.stop()
                }
            }))
            .build()
            .map_err(|_| "同步客户端初始化失败".to_string())?;
        let auth = match token.trim() {
            "" => None,
            t => {
                let mut v = HeaderValue::from_str(&format!("Bearer {t}"))
                    .map_err(|_| "访问令牌无效".to_string())?;
                v.set_sensitive(true);
                Some(v)
            }
        };
        Ok(Self { client, base, auth })
    }

    async fn send<T: DeserializeOwned>(&self, req: RequestBuilder, tag: &str) -> Result<T, String> {
        let req = match &self.auth {
            Some(v) => req.header(AUTHORIZATION, v.clone()),
            None => req,
        };
        let res = req.send().await.map_err(|e| net_error(tag, &e))?;
        let status = res.status();
        if !status.is_success() {
            return Err(format!("{tag}_{}", status.as_u16()));
        }
        if res.content_length().is_some_and(|n| n as usize > MAX_BODY) {
            return Err(format!("{tag}_too_large"));
        }
        let bytes = res.bytes().await.map_err(|e| net_error(tag, &e))?;
        if bytes.len() > MAX_BODY {
            return Err(format!("{tag}_too_large"));
        }
        serde_json::from_slice(&bytes).map_err(|_| format!("{tag}_invalid_response"))
    }

    pub async fn identity(&self) -> Result<super::storage::Identity, String> {
        let identity: super::storage::Identity = self
            .send(
                self.client.get(endpoint(&self.base, "identity")),
                "identity",
            )
            .await
            .map_err(|e| {
                if e == "identity_404" {
                    "同步服务器需要升级：缺少账户验证接口".into()
                } else {
                    e
                }
            })?;
        identity.validate()?;
        Ok(identity)
    }

    pub async fn push<T: DeserializeOwned>(&self, body: &serde_json::Value) -> Result<T, String> {
        let body = serde_json::to_vec(body).map_err(|e| e.to_string())?;
        let req = self
            .client
            .post(endpoint(&self.base, "push"))
            .header(CONTENT_TYPE, "application/json")
            .body(body);
        self.send(req, "push").await
    }

    pub async fn pull<T: DeserializeOwned>(
        &self,
        workspace: &str,
        since: i64,
    ) -> Result<T, String> {
        self.send(
            self.client.get(pull_url(&self.base, workspace, since)),
            "pull",
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_address_rules() {
        assert!(parse_server("https://lumo.example.com").is_ok());
        assert!(parse_server("https://lumo.example.com:8443/base").is_ok());
        assert!(parse_server("http://127.0.0.1:8086").is_ok());
        assert!(parse_server("http://localhost:3000").is_ok());
        assert!(parse_server("http://[::1]:3000").is_ok());
        for bad in [
            "",
            "http://lumo.example.com",
            "http://127.0.0.1.evil.com",
            "ftp://x",
            "https://a b",
            "https://user:pw@lumo.example.com",
            "https://lumo.example.com/?q=1",
            "https://lumo.example.com/#f",
            "javascript:alert(1)",
            "lumo.example.com",
        ] {
            assert!(parse_server(bad).is_err(), "{bad}");
        }
        assert!(parse_server(&format!("https://{}.com", "a".repeat(520))).is_err());
    }

    #[test]
    fn endpoints_keep_base_path_and_encode_query() {
        let base = parse_server("https://lumo.example.com/sync/").unwrap();
        assert_eq!(
            endpoint(&base, "push").as_str(),
            "https://lumo.example.com/sync/v1/memory-sync/push"
        );
        let root = parse_server("https://lumo.example.com").unwrap();
        assert_eq!(
            pull_url(&root, "a&b", 3).as_str(),
            "https://lumo.example.com/v1/memory-sync/changes?workspace=a%26b&since=3"
        );
    }

    #[test]
    fn redirects_only_same_origin_and_bounded() {
        let base = parse_server("https://lumo.example.com").unwrap();
        let same = Url::parse("https://lumo.example.com/v2/x").unwrap();
        assert!(redirect_allowed(&base, &same, 0));
        assert!(!redirect_allowed(&base, &same, MAX_REDIRECTS));
        for other in [
            "https://evil.example.com/x",
            "http://lumo.example.com/x",
            "https://lumo.example.com:444/x",
        ] {
            assert!(
                !redirect_allowed(&base, &Url::parse(other).unwrap(), 0),
                "{other}"
            );
        }
    }

    #[test]
    fn token_must_be_header_safe() {
        assert!(Remote::new("https://lumo.example.com", "bad\ntoken").is_err());
        assert!(Remote::new("https://lumo.example.com", "")
            .unwrap()
            .auth
            .is_none());
        assert!(Remote::new("https://lumo.example.com", "t")
            .unwrap()
            .auth
            .unwrap()
            .is_sensitive());
        assert!(Remote::new("http://lumo.example.com", "t").is_err());
    }
}
