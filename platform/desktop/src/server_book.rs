//! One address book shared by the local workbench and the pet. Never stores credentials.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, path::Path, sync::Mutex};

static LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Server {
    pub name: String,
    pub origin: String,
}

pub fn origin(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    let invalid = "请输入 HTTPS 地址；仅本机回环地址允许 HTTP，不能包含账号、路径或令牌";
    if raw.is_empty()
        || raw.len() > 512
        || raw.contains(['\\', '?', '#', '@'])
        || raw.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(invalid.into());
    }
    let authority = raw
        .split_once("://")
        .ok_or(invalid)?
        .1
        .trim_end_matches('/');
    if authority.contains('/') {
        return Err(invalid.into());
    }
    let url: tauri::Url = raw.parse().map_err(|_| invalid)?;
    let loopback = url.host_str().is_some_and(|h| {
        h == "localhost"
            || h == "[::1]"
            || h == "::1"
            || h.parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
    {
        return Err(invalid.into());
    }
    Ok(url.origin().ascii_serialization())
}

fn checked(item: Server) -> Result<Server, String> {
    let name = item.name.trim();
    if name.is_empty() || name.chars().count() > 60 || name.chars().any(char::is_control) {
        return Err("服务器名称需为 1–60 个字符".into());
    }
    Ok(Server {
        name: name.into(),
        origin: origin(&item.origin)?,
    })
}

fn load(dir: &Path) -> Result<Vec<Server>, String> {
    let file = dir.join("server-book.json");
    match fs::read(file) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(format!("无法读取地址簿：{e}")),
        Ok(raw) => {
            let items: Vec<Server> =
                serde_json::from_slice(&raw).map_err(|_| "地址簿已损坏，原文件未被覆盖")?;
            let items: Vec<Server> = items.into_iter().map(checked).collect::<Result<_, _>>()?;
            if items.len() > 12
                || items
                    .iter()
                    .enumerate()
                    .any(|(i, item)| items[..i].iter().any(|p| p.origin == item.origin))
            {
                return Err("地址簿已损坏，原文件未被覆盖".into());
            }
            Ok(items)
        }
    }
}

pub fn read(dir: &Path) -> Result<Vec<Server>, String> {
    let _lock = LOCK.lock().map_err(|_| "地址簿暂不可用")?;
    load(dir)
}

pub fn update(dir: &Path, change: &Value) -> Result<Vec<Server>, String> {
    let _lock = LOCK.lock().map_err(|_| "地址簿暂不可用")?;
    let mut items = load(dir)?;
    if let Some(remove) = change.get("remove").and_then(Value::as_str) {
        let remove = origin(remove)?;
        items.retain(|item| item.origin != remove);
    } else if let Some(save) = change.get("save") {
        let entry =
            checked(serde_json::from_value(save.clone()).map_err(|_| "服务器地址格式错误")?)?;
        let previous = change
            .get("previous")
            .and_then(Value::as_str)
            .map(origin)
            .transpose()?;
        if items
            .iter()
            .any(|i| i.origin == entry.origin && Some(&i.origin) != previous.as_ref())
        {
            return Err("该服务器已在地址簿中".into());
        }
        if let Some(previous) = previous {
            let i = items
                .iter()
                .position(|i| i.origin == previous)
                .ok_or("记录已变化，请刷新后重试")?;
            items[i] = entry;
        } else {
            if items.len() == 12 {
                return Err("最多保存 12 个服务器".into());
            }
            items.push(entry);
        }
    } else if let Some(merge) = change.get("merge") {
        // First-use browser migration never replaces a native record of the same origin.
        let incoming: Vec<Server> =
            serde_json::from_value(merge.clone()).map_err(|_| "迁移地址格式错误")?;
        for entry in incoming {
            let entry = checked(entry)?;
            if !items.iter().any(|i| i.origin == entry.origin) {
                items.push(entry);
            }
        }
        if items.len() > 12 {
            return Err("迁移后超过 12 个地址，请先整理地址簿".into());
        }
    } else {
        return Err("未知地址簿操作".into());
    }
    crate::desktop_connections::private_json(&dir.join("server-book.json"), &items)?;
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn shares_normalized_origins_and_preserves_corruption() {
        let dir = std::env::temp_dir().join(format!("lumo-book-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let a = update(
            &dir,
            &json!({"save":{"name":"A","origin":"https://EXAMPLE.com/"}}),
        )
        .unwrap();
        assert_eq!(a[0].origin, "https://example.com");
        assert!(update(
            &dir,
            &json!({"save":{"name":"B","origin":"https://example.com"}})
        )
        .is_err());
        let items = update(&dir,&json!({"merge":[{"name":"old","origin":"https://example.com"},{"name":"Tunnel","origin":"http://127.0.0.1:1234"}]})).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].name, "A");
        fs::write(dir.join("server-book.json"), b"broken").unwrap();
        assert!(update(&dir, &json!({"remove":"https://example.com"})).is_err());
        assert_eq!(fs::read(dir.join("server-book.json")).unwrap(), b"broken");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rejects_remote_http_and_secrets() {
        for bad in [
            "http://remote.example",
            "https://user:secret@example.com",
            "https://a.example/path",
            "https://a.example?token=x",
            "file:///tmp/x",
        ] {
            assert!(origin(bad).is_err());
        }
        assert_eq!(origin("http://[::1]:33/").unwrap(), "http://[::1]:33");
    }
}
