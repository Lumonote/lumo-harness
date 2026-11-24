use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PetAttachment {
    name: String,
    mime_type: String,
    base64: String,
}

const PET_MAX_FILES: usize = 4;
const PET_FILE_BYTES: usize = 8 * 1024 * 1024;
const PET_TOTAL_BYTES: usize = 16 * 1024 * 1024;

fn attachment_bytes(file: &PetAttachment) -> Result<usize, String> {
    let raw = file.base64.as_bytes();
    if file.name.is_empty()
        || file.name.chars().count() > 255
        || file
            .name
            .chars()
            .any(|ch| ch.is_control() || ch == '/' || ch == '\\')
        || file.mime_type.len() > 255
        || file.mime_type.chars().any(char::is_control)
        || raw.is_empty()
        || raw.len() > (PET_FILE_BYTES + 2) / 3 * 4
        || raw.len() % 4 != 0
    {
        return Err("附件名称、类型或大小无效".into());
    }
    let padding = raw.iter().rev().take_while(|&&ch| ch == b'=').count();
    if padding > 2
        || raw[..raw.len() - padding]
            .iter()
            .any(|ch| !ch.is_ascii_alphanumeric() && *ch != b'+' && *ch != b'/')
    {
        return Err("附件编码无效".into());
    }
    let bytes = raw.len() / 4 * 3 - padding;
    if bytes > PET_FILE_BYTES {
        return Err("单个附件不能超过 8 MB".into());
    }
    Ok(bytes)
}

pub(super) fn validate_pet_request(
    target: &str,
    draft: &str,
    workspace_id: Option<&str>,
    request_id: Option<&str>,
    attachments: &[PetAttachment],
) -> Result<bool, String> {
    if !["home", "chat", "tasks"].contains(&target)
        || draft.encode_utf16().count() > 12000
        || (target != "chat"
            && (!draft.is_empty() || !attachments.is_empty() || workspace_id.is_some()))
    {
        return Err("无效的桌宠请求".into());
    }
    if let Some(id) = workspace_id {
        if id.trim().is_empty() || id.len() > 1024 || id.chars().any(char::is_control) {
            return Err("请选择有效的工作空间".into());
        }
    }
    if let Some(id) = request_id {
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == b'_' || ch == b'-')
        {
            return Err("发送标识无效".into());
        }
    }
    let submitting = target == "chat" && (!draft.trim().is_empty() || !attachments.is_empty());
    if submitting && (workspace_id.is_none() || request_id.is_none()) {
        return Err("发送需要工作空间和请求标识".into());
    }
    if attachments.len() > PET_MAX_FILES {
        return Err("最多添加 4 个附件".into());
    }
    let mut total = 0;
    for file in attachments {
        total += attachment_bytes(file)?;
    }
    if total > PET_TOTAL_BYTES {
        return Err("附件总大小不能超过 16 MB".into());
    }
    Ok(submitting)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_requests_require_workspace_and_stable_identity() {
        assert_eq!(
            validate_pet_request("chat", "hello", Some("workspace-1"), Some("request_1"), &[]),
            Ok(true)
        );
        assert_eq!(
            validate_pet_request("chat", "", Some("workspace-1"), None, &[]),
            Ok(false)
        );
        assert!(validate_pet_request("chat", "hello", None, Some("request-1"), &[]).is_err());
        assert!(validate_pet_request("chat", "hello", Some("workspace-1"), None, &[]).is_err());
        assert!(validate_pet_request(
            "chat",
            "hello",
            Some("workspace-1"),
            Some("bad/request"),
            &[]
        )
        .is_err());
        assert!(validate_pet_request("home", "hello", None, None, &[]).is_err());
        assert!(validate_pet_request("tasks", "", Some("workspace-1"), None, &[]).is_err());
    }

    #[test]
    fn attachments_are_bounded_and_encoded_as_plain_base64() {
        let file = PetAttachment {
            name: "report.txt".into(),
            mime_type: "text/plain".into(),
            base64: "YQ==".into(),
        };
        assert_eq!(attachment_bytes(&file), Ok(1));
        assert_eq!(
            validate_pet_request(
                "chat",
                "",
                Some("workspace-1"),
                Some("request-1"),
                &[file.clone()]
            ),
            Ok(true)
        );
        for encoded in [
            "",
            "=",
            "data:text/plain;base64,YQ==",
            "YQ=",
            "Y===",
            "YQ==AAAA",
        ] {
            assert!(
                attachment_bytes(&PetAttachment {
                    base64: encoded.into(),
                    ..file.clone()
                })
                .is_err(),
                "{encoded}"
            );
        }
        for name in ["../secret", "folder\\report", "bad\nname", ""] {
            assert!(attachment_bytes(&PetAttachment {
                name: name.into(),
                ..file.clone()
            })
            .is_err());
        }
        assert!(validate_pet_request(
            "chat",
            "",
            Some("workspace-1"),
            Some("request-1"),
            &vec![file.clone(); 5]
        )
        .is_err());
        let full = PetAttachment {
            base64: "AAAA".repeat(PET_FILE_BYTES / 3 + 1),
            ..file
        };
        assert!(attachment_bytes(&full).is_err());
    }
}
