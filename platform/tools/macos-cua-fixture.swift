// Disposable acceptance application. Input effects are recorded independently of the CUA helper.
import AppKit

final class AcceptanceFixture: NSObject, NSApplicationDelegate, NSTextViewDelegate {
    let statePath: String
    let nonce: String
    var window: NSWindow!
    var text: NSTextView!
    var clicks = 0
    init(statePath: String, nonce: String) { self.statePath = statePath; self.nonce = nonce }
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 160, y: 180, width: 600, height: 320),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Lumo CUA acceptance \(nonce)"
        window.isReleasedWhenClosed = false
        window.animationBehavior = .none
        let button = NSButton(title: "Prepare input", target: self, action: #selector(prepareInput))
        button.frame = NSRect(x: 20, y: 250, width: 180, height: 40)
        button.setAccessibilityIdentifier("lumo-cua-prepare")
        window.contentView!.addSubview(button)
        text = NSTextView(frame: NSRect(x: 20, y: 20, width: 560, height: 210))
        text.isRichText = false
        text.isEditable = true
        text.font = .systemFont(ofSize: 22)
        text.setAccessibilityLabel("Acceptance input")
        text.delegate = self
        window.contentView!.addSubview(text)
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        persist()
    }
    @objc func prepareInput() {
        clicks += 1
        window.makeFirstResponder(text)
        persist()
    }
    func textDidChange(_ notification: Notification) { persist() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func persist() {
        let state: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier,
            "windowId": window.windowNumber, "nonce": nonce, "clicks": clicks, "text": text.string,
            "bundleId": Bundle.main.bundleIdentifier ?? "", "title": window.title]
        do { try JSONSerialization.data(withJSONObject: state).write(to: URL(fileURLWithPath: statePath), options: .atomic) }
        catch { fputs("Fixture state write failed: \(error)\n", stderr); exit(1) }
    }
}

guard CommandLine.arguments.count == 3 else { fputs("Expected private state path and nonce\n", stderr); exit(2) }
let application = NSApplication.shared
application.setActivationPolicy(.regular)
let fixture = AcceptanceFixture(statePath: CommandLine.arguments[1], nonce: CommandLine.arguments[2])
application.delegate = fixture
application.run()
