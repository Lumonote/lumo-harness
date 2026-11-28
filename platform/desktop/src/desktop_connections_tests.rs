use super::*;

fn root() -> PathBuf {
    let p = std::env::temp_dir().join(format!("lumo-connection-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&p).unwrap();
    p
}
fn configuration(root: &Path) -> ConnectionConfig {
    let trust = root.join("publishers.json");
    private_json(
        &trust,
        &json!({"publishers":[{"id":"test","public_key":"test","max_scopes":[]}]}),
    )
    .unwrap();
    ConnectionConfig {
        gateway: "https://devices.example.com".into(),
        realm: "team".into(),
        node_id: "laptop".into(),
        trust_file: trust.to_string_lossy().into_owned(),
        server_ca: String::new(),
        task_runner_socket: String::new(),
        allowed_digests: vec![],
        client_version: client_version(),
        paused: false,
    }
}

#[test]
fn activation_rejection_and_missing_agent_do_not_commit_identity() {
    let dir = root();
    let c = configuration(&dir);
    let mut service = Connections::new(&dir, None);
    let body = json!({"config":c,"code":"a".repeat(43)});
    assert!(service
        .action("activate", &body, |_| Ok(false))
        .unwrap_err()
        .contains("取消"));
    assert!(!service.config_file().exists());
    assert!(service
        .action("activate", &body, |_| Ok(true))
        .unwrap_err()
        .contains("未安装"));
    assert!(!service.config_file().exists());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn corrupted_config_is_preserved_and_private_state_is_not_projected() {
    let dir = root();
    let mut service = Connections::new(&dir, None);
    fs::create_dir_all(&service.root).unwrap();
    fs::write(service.config_file(), b"broken").unwrap();
    assert!(service.snapshot().is_err());
    assert_eq!(fs::read(service.config_file()).unwrap(), b"broken");
    fs::remove_file(service.config_file()).unwrap();
    let c = configuration(&dir);
    private_json(&service.config_file(), &c).unwrap();
    private_json(&service.identity_dir(&c).join("status.json"),&json!({"connected":true,"pid":std::process::id(),"last_gateway_at_ms":now(),"certificate_expires_ms":now()+60000,"key":"private","certificate":"secret","code":"one-time"})).unwrap();
    let snapshot = service.snapshot().unwrap();
    assert_eq!(snapshot["status"]["connected"], false);
    assert_eq!(snapshot["status"]["state"], "stopped");
    assert!(!snapshot.to_string().contains("private"));
    assert!(!snapshot.to_string().contains("one-time"));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn pause_and_leave_are_durable_and_leave_retains_task_receipts() {
    let dir = root();
    let mut service = Connections::new(&dir, None);
    let c = configuration(&dir);
    private_json(&service.config_file(), &c).unwrap();
    private_json(
        &service.identity_dir(&c).join("identity.json"),
        &json!({"key":"private"}),
    )
    .unwrap();
    private_json(
        &service.identity_dir(&c).join("tasks").join("receipt.json"),
        &json!({"state":"COMPLETED"}),
    )
    .unwrap();
    service
        .action("pause", &json!({}), |_| panic!("pause should not prompt"))
        .unwrap();
    assert!(service.config().unwrap().unwrap().paused);
    assert!(service.action("leave", &json!({}), |_| Ok(false)).is_err());
    assert!(service.config_file().exists());
    service.action("leave", &json!({}), |_| Ok(true)).unwrap();
    assert!(!service.config_file().exists());
    assert!(!service.identity_dir(&c).join("identity.json").exists());
    assert!(service.identity_dir(&c).join("tasks/receipt.json").exists());
    fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[test]
fn only_live_process_with_fresh_gateway_and_certificate_is_connected() {
    use std::os::unix::process::CommandExt;
    let dir = root();
    let mut service = Connections::new(&dir, None);
    let c = configuration(&dir);
    private_json(&service.config_file(), &c).unwrap();
    let child = Command::new("/bin/sleep")
        .arg("30")
        .process_group(0)
        .spawn()
        .unwrap();
    let pid = child.id();
    service.child = Some(child);
    let path = service.identity_dir(&c).join("status.json");
    let status = json!({"state":"connected","connected":true,"pid":pid,"last_gateway_at_ms":now(),"certificate_expires_ms":now()+60000});
    private_json(&path, &status).unwrap();
    assert_eq!(service.snapshot().unwrap()["status"]["connected"], true);
    for changed in [
        json!({"pid":pid+1}),
        json!({"last_gateway_at_ms":now()-60000}),
        json!({"certificate_expires_ms":now()-1}),
    ] {
        let mut invalid = status.clone();
        for (key, value) in changed.as_object().unwrap() {
            invalid[key] = value.clone();
        }
        private_json(&path, &invalid).unwrap();
        assert_eq!(service.snapshot().unwrap()["status"]["connected"], false);
    }
    service.stop();
    assert_eq!(service.snapshot().unwrap()["status"]["connected"], false);
    fs::remove_dir_all(dir).unwrap();
}
