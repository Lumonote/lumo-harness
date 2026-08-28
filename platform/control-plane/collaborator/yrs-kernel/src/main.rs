use std::io::{self, BufRead, Write};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use yrs::updates::decoder::Decode;
use yrs::{Doc, GetString, ReadTxn, StateVector, Transact, Update};

#[derive(Deserialize)]
struct Request {
    #[serde(default)]
    state: String,
    #[serde(default)]
    updates: Vec<UpdateInput>,
}

#[derive(Deserialize)]
struct UpdateInput {
    payload: String,
}

#[derive(Serialize)]
struct Response {
    state: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn merge(request: Request) -> Result<Response, String> {
    let doc = Doc::new();
    if !request.state.is_empty() {
        let bytes = STANDARD
            .decode(request.state)
            .map_err(|e| format!("state base64: {e}"))?;
        let update = Update::decode_v1(&bytes).map_err(|e| format!("state update: {e}"))?;
        doc.transact_mut()
            .apply_update(update)
            .map_err(|e| format!("apply state: {e}"))?;
    }
    for input in request.updates {
        let bytes = STANDARD
            .decode(input.payload)
            .map_err(|e| format!("update base64: {e}"))?;
        let update = Update::decode_v1(&bytes).map_err(|e| format!("update: {e}"))?;
        doc.transact_mut()
            .apply_update(update)
            .map_err(|e| format!("apply update: {e}"))?;
    }
    let content_ref = doc.get_or_insert_text("content");
    let txn = doc.transact();
    let state = txn.encode_state_as_update_v1(&StateVector::default());
    let content = content_ref.get_string(&txn);
    Ok(Response {
        state: STANDARD.encode(state),
        content,
        error: None,
    })
}

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout());
    for line in stdin.lock().lines() {
        let response = match line {
            Ok(line) => match serde_json::from_str::<Request>(&line) {
                Ok(request) => merge(request).unwrap_or_else(|error| Response {
                    state: String::new(),
                    content: String::new(),
                    error: Some(error),
                }),
                Err(error) => Response {
                    state: String::new(),
                    content: String::new(),
                    error: Some(format!("request json: {error}")),
                },
            },
            Err(error) => Response {
                state: String::new(),
                content: String::new(),
                error: Some(format!("stdin: {error}")),
            },
        };
        let _ = serde_json::to_writer(&mut stdout, &response);
        let _ = stdout.write_all(b"\n");
        let _ = stdout.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::Text;

    #[test]
    fn concurrent_updates_converge_and_materialize() {
        let left = Doc::with_client_id(1);
        let left_text = left.get_or_insert_text("content");
        left_text.insert(&mut left.transact_mut(), 0, "a");
        let left_update = left
            .transact()
            .encode_state_as_update_v1(&StateVector::default());

        let right = Doc::with_client_id(2);
        let right_text = right.get_or_insert_text("content");
        right_text.insert(&mut right.transact_mut(), 0, "b");
        let right_update = right
            .transact()
            .encode_state_as_update_v1(&StateVector::default());

        let response = merge(Request {
            state: String::new(),
            updates: vec![
                UpdateInput {
                    payload: STANDARD.encode(right_update),
                },
                UpdateInput {
                    payload: STANDARD.encode(left_update),
                },
            ],
        })
        .expect("yrs merge");
        assert_eq!(response.content.len(), 2);
        assert!(response.content.contains('a'));
        assert!(response.content.contains('b'));
        assert!(!response.state.is_empty());
    }
}
