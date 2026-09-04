import UIKit
import Capacitor
import os.log

// ── Share Extension hand-off ─────────────────────────────────────────────────
//
// These two classes live in this file (already a compile source of the App
// target) rather than their own files on purpose: it keeps main buildable
// without any "add files to target" step in Xcode. See
// ios/SHARE_EXTENSION_SETUP.md for the extension-target side.

/// Bridge for the Share Extension hand-off. The extension
/// (share-extension-src/ShareViewController.swift) writes the shared text into
/// App Group UserDefaults; the web layer (src/lib/shareImport.js) calls take()
/// to collect it.
///
/// take() is read-AND-clear in one call: whether or not the payload gets used,
/// it is gone from the App Group afterwards, so stale text can never leak into
/// a later import.
@objc(SharedImportPlugin)
public class SharedImportPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SharedImportPlugin"
    public let jsName = "SharedImport"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "take", returnType: CAPPluginReturnPromise)
    ]

    // Must match share-extension-src/ShareViewController.swift.
    private static let appGroupId = "group.com.adamlai.flownotes"
    private static let textKey = "shareText"
    private static let tsKey = "shareTs"

    @objc func take(_ call: CAPPluginCall) {
        guard let defaults = UserDefaults(suiteName: Self.appGroupId) else {
            call.resolve([:])
            return
        }
        let text = defaults.string(forKey: Self.textKey)
        let ts = defaults.double(forKey: Self.tsKey)
        defaults.removeObject(forKey: Self.textKey)
        defaults.removeObject(forKey: Self.tsKey)

        if let text = text, !text.isEmpty {
            call.resolve(["text": text, "ts": ts])
        } else {
            call.resolve([:])
        }
    }
}

// ── Siri voice capture queue ────────────────────────────────────────────────
//
// The App Group hand-off for AddNoteIntent (ios/voice-capture-src, compiled
// into the App target by ios/VOICE_CAPTURE_SETUP.md). Lives here, in an
// existing compile source, for the same reason SharedImportPlugin does: main
// builds without any "add files" step. Until the intent is added this code is
// registered but idle — the queue directory is simply never written to.
//
// Why NOT the share extension's single UserDefaults key: Siri can queue
// several notes before Nubble is next opened, and two processes doing
// read-modify-write on one key have no lock — the app clearing the key right
// after an intent appended to it would drop a capture. So each capture is its
// own file in the App Group container, written atomically. Nothing ever
// rewrites another capture's data, and the app deletes a file only after the
// web layer confirms that capture is in localStorage (list, persist, ack).
// Captures never expire: unlike a share, a spoken note is a committed note.

enum VoiceCaptureError: LocalizedError {
    case appGroupUnavailable
    case readbackFailed

    // Siri reads this aloud when the intent throws.
    var errorDescription: String? {
        switch self {
        case .appGroupUnavailable: return "Nubble couldn't save the note. Please open Nubble and try again."
        case .readbackFailed:      return "Nubble couldn't verify the note was saved. Please try again."
        }
    }
}

enum VoiceCaptureStore {
    // Must match the App Group on the App target (App.entitlements). Same
    // group the share extension uses — no second group.
    static let appGroupId = "group.com.adamlai.flownotes"
    private static let folderName = "VoiceCaptures"

    /// Posted (main queue) after every successful append. VoiceCapturePlugin
    /// relays it to the web layer so a note spoken while Nubble is open lands
    /// immediately instead of on the next foreground.
    static let addedNotification = Notification.Name("com.adamlai.flownotes.VoiceCaptureStore.added")

    private static let log = Logger(subsystem: "com.adamlai.flownotes.VoiceCapture", category: "store")

    /// The queue directory inside the App Group container, created on first
    /// use by whichever process gets there first — the intent can run before
    /// the app has ever launched.
    static func directory() throws -> URL {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
            log.error("App Group unavailable — capability missing on the App target?")
            throw VoiceCaptureError.appGroupUnavailable
        }
        let dir = container.appendingPathComponent(folderName, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Writes one capture as its own file and returns its id. The id becomes
    /// the note's id on the web side, which is what makes re-delivery after a
    /// crash between persist and ack idempotent.
    ///
    /// bubbleId / bubbleName are FILING HINTS, both optional and independent:
    /// the web consumer files by id if that bubble still exists, else by name
    /// if exactly one bubble has it, else at root. They never gate the write.
    @discardableResult
    static func append(_ text: String, bubbleId: String? = nil, bubbleName: String? = nil) throws -> String {
        let dir = try directory()
        let id = UUID().uuidString.lowercased()
        // ts in milliseconds so JS can feed it straight to new Date(): the
        // note is stamped with when it was SPOKEN, not when Nubble next opened.
        var payload: [String: Any] = [
            "id": id,
            "text": text,
            "ts": Date().timeIntervalSince1970 * 1000,
        ]
        if let bubbleId = bubbleId, !bubbleId.isEmpty { payload["bubbleId"] = bubbleId }
        if let bubbleName = bubbleName, !bubbleName.isEmpty { payload["bubbleName"] = bubbleName }
        let data = try JSONSerialization.data(withJSONObject: payload)
        let url = dir.appendingPathComponent(id).appendingPathExtension("json")
        try data.write(to: url, options: .atomic)

        // Read-back verification, same discipline as the share extension:
        // prove the bytes landed before Siri says "Added".
        guard let back = try? Data(contentsOf: url), back == data else {
            log.error("capture \(id, privacy: .public) FAILED readback")
            try? FileManager.default.removeItem(at: url)
            throw VoiceCaptureError.readbackFailed
        }
        let depth = (try? FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".json") }.count) ?? -1
        log.notice("capture \(id, privacy: .public) written: \(text.count, privacy: .public) chars, queue depth \(depth, privacy: .public)")

        DispatchQueue.main.async {
            NotificationCenter.default.post(name: addedNotification, object: nil)
        }
        return id
    }

    /// Every queued capture, oldest first. Read-only: nothing is removed
    /// until ack(). A file that fails to parse is logged and skipped, never
    /// deleted — it stays for a human to look at rather than vanishing.
    static func list() -> [[String: Any]] {
        guard let dir = try? directory() else { return [] }
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return [] }
        var captures: [[String: Any]] = []
        for name in names where name.hasSuffix(".json") {
            let url = dir.appendingPathComponent(name)
            guard let data = try? Data(contentsOf: url),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let id = obj["id"] as? String, !id.isEmpty,
                  let text = obj["text"] as? String, !text.isEmpty
            else {
                log.error("skipping unreadable capture file \(name, privacy: .public)")
                continue
            }
            var capture: [String: Any] = [
                "id": id,
                "text": text,
                "ts": (obj["ts"] as? Double) ?? 0,
            ]
            if let bubbleId = obj["bubbleId"] as? String, !bubbleId.isEmpty { capture["bubbleId"] = bubbleId }
            if let bubbleName = obj["bubbleName"] as? String, !bubbleName.isEmpty { capture["bubbleName"] = bubbleName }
            captures.append(capture)
        }
        captures.sort { (($0["ts"] as? Double) ?? 0) < (($1["ts"] as? Double) ?? 0) }
        if !captures.isEmpty {
            log.notice("list: \(captures.count, privacy: .public) queued capture(s)")
        }
        return captures
    }

    /// Deletes exactly the given captures. Called by the web layer only after
    /// those notes are in localStorage.
    static func ack(_ ids: [String]) {
        guard !ids.isEmpty, let dir = try? directory() else { return }
        var removed = 0
        for id in ids {
            // ids are our own lowercase UUID strings; refuse anything else so a
            // malformed id can never resolve to a path outside the queue.
            guard id.range(of: "^[0-9a-f-]{36}$", options: .regularExpression) != nil else { continue }
            let url = dir.appendingPathComponent(id).appendingPathExtension("json")
            if (try? FileManager.default.removeItem(at: url)) != nil { removed += 1 }
        }
        log.notice("ack: removed \(removed, privacy: .public) of \(ids.count, privacy: .public)")
    }

    // ── Bubble mirror ────────────────────────────────────────────────────────
    //
    // The bubble list Siri's entity query reads (voice-capture-src/
    // BubbleEntity.swift). Written by the web layer through setBubbles();
    // lives beside the queue, NOT inside it, so list()/ack() never see it.
    // Read best-effort: an unreadable mirror means "no bubbles", never an
    // error, because the intent must run regardless.

    private static let bubblesFileName = "bubbles.json"

    private static func bubblesURL() throws -> URL {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
            throw VoiceCaptureError.appGroupUnavailable
        }
        return container.appendingPathComponent(bubblesFileName)
    }

    static func writeBubbles(_ records: [[String: Any]]) throws {
        let url = try bubblesURL()
        let data = try JSONSerialization.data(withJSONObject: records)
        try data.write(to: url, options: .atomic)
        log.notice("bubble mirror written: \(records.count, privacy: .public) bubble(s)")
    }

    static func bubbleRecords() -> [[String: Any]] {
        guard let url = try? bubblesURL(),
              let data = try? Data(contentsOf: url),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
        else { return [] }
        return arr
    }
}

/// Bridge between VoiceCaptureStore and the web layer (src/lib/voiceCapture.js).
///
/// Two-phase on purpose — list() is read-only and ack(ids) deletes — so a
/// crash between reading a capture and saving it as a note loses nothing:
/// the capture is simply listed again next time. (Contrast SharedImportPlugin's
/// read-and-clear take(), which is fine for a single share the user is
/// standing there waiting for, and not fine for a queue of spoken notes.)
@objc(VoiceCapturePlugin)
public class VoiceCapturePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VoiceCapturePlugin"
    public let jsName = "VoiceCapture"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBubbles", returnType: CAPPluginReturnPromise),
    ]

    private var observer: NSObjectProtocol?

    public override func load() {
        // Same-process signal: the intent ran inside an already-running Nubble.
        // retainUntilConsumed so an event fired before the web layer has
        // subscribed (cold start) is delivered once it does.
        observer = NotificationCenter.default.addObserver(
            forName: VoiceCaptureStore.addedNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.notifyListeners("captured", data: [:], retainUntilConsumed: true)
        }
    }

    deinit {
        if let observer = observer { NotificationCenter.default.removeObserver(observer) }
    }

    @objc func list(_ call: CAPPluginCall) {
        call.resolve(["captures": VoiceCaptureStore.list()])
    }

    @objc func ack(_ call: CAPPluginCall) {
        let ids = call.getArray("ids", String.self) ?? []
        VoiceCaptureStore.ack(ids)
        call.resolve()
    }

    /// Replace the bubble mirror with what the web layer sends, then ask
    /// Siri to re-read it. Only string fields are kept, so nothing the web
    /// side didn't mean to expose can end up in the file.
    @objc func setBubbles(_ call: CAPPluginCall) {
        let raw = call.getArray("bubbles") ?? []
        let records: [[String: Any]] = raw.compactMap { item in
            guard let d = item as? [String: Any],
                  let id = d["id"] as? String, !id.isEmpty,
                  let name = d["name"] as? String, !name.isEmpty else { return nil }
            var r: [String: Any] = ["id": id, "name": name]
            if let path = d["path"] as? String, !path.isEmpty { r["path"] = path }
            if let project = d["project"] as? String, !project.isEmpty { r["project"] = project }
            if let projectId = d["projectId"] as? String, !projectId.isEmpty { r["projectId"] = projectId }
            return r
        }
        do {
            try VoiceCaptureStore.writeBubbles(records)
        } catch {
            call.reject("bubble mirror write failed: \(error.localizedDescription)")
            return
        }
        Self.refreshSiriParameters()
        call.resolve()
    }

    /// Tell Siri the bubble entity set changed. Dispatched BY CLASS NAME so
    /// this file keeps compiling before voice-capture-src is in the target
    /// (the same necessity the share extension's launchHostApp documents):
    /// VoiceBubbleSync lives in BubbleEntity.swift and imports AppIntents.
    /// Absent, this is a silent no-op — the mirror is still written and the
    /// next reinstall picks it up.
    private static func refreshSiriParameters() {
        guard let cls = NSClassFromString("VoiceBubbleSync") else { return }
        let sel = NSSelectorFromString("refresh")
        let obj = cls as AnyObject
        guard obj.responds(to: sel) else { return }
        _ = obj.perform(sel)
    }
}

/// The app's bridge view controller. Exists only to register plugins defined
/// in the app project itself (Capacitor auto-discovers packaged plugins, but
/// local ones must be registered by hand since Capacitor 6).
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(SharedImportPlugin())
        bridge?.registerPluginInstance(VoiceCapturePlugin())
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        // MainViewController (not plain CAPBridgeViewController) so locally
        // defined plugins — SharedImportPlugin — get registered on the bridge.
        window?.rootViewController = MainViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
