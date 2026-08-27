import UIKit
import UniformTypeIdentifiers

/// Nubble's share sheet entry. Deliberately minimal: extensions run under
/// tight memory limits, so this does nothing with the text beyond handing it
/// off — write it to App Group UserDefaults, ping the main app with a bare
/// trigger URL (the text never rides in the URL; long notes would risk
/// truncation), and complete the request. All preview / split / destination
/// UI lives in the app's existing Import screen.
///
/// Accepts plain text and URLs only — the activation rule in Info.plist keeps
/// Nubble out of the share sheet for anything else, so images and files are
/// declined by never matching rather than half-handled here.
class ShareViewController: UIViewController {

    // Must match SharedImportPlugin.swift in the App target.
    private static let appGroupId = "group.com.adamlai.flownotes"
    private static let textKey = "shareText"
    private static let tsKey = "shareTs"

    private static let triggerURL = "com.adamlai.flownotes://share-import"

    private var didHandle = false

    override func viewDidLoad() {
        super.viewDidLoad()
        // No UI of our own — the sheet appears and dismisses immediately.
        view.backgroundColor = .clear
        view.isOpaque = false
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !didHandle else { return }
        didHandle = true
        handleShare()
    }

    private func handleShare() {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem])?
            .flatMap { $0.attachments ?? [] } ?? []

        // Prefer plain text; fall back to a URL rendered as its string.
        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) }) {
            provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { [weak self] data, _ in
                // Some hosts hand plain text over as NSData rather than NSString.
                var text = data as? String
                if text == nil, let d = data as? Data { text = String(data: d, encoding: .utf8) }
                self?.finish(with: text)
            }
        } else if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.url.identifier) }) {
            provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { [weak self] data, _ in
                let url = data as? URL
                self?.finish(with: url?.absoluteString)
            }
        } else {
            // Activation rules should prevent this, but decline cleanly if a
            // host slips something unexpected through.
            complete()
        }
    }

    private func finish(with text: String?) {
        DispatchQueue.main.async {
            guard let text = text, !text.isEmpty,
                  let defaults = UserDefaults(suiteName: Self.appGroupId) else {
                self.complete()
                return
            }
            defaults.set(text, forKey: Self.textKey)
            // Milliseconds, to compare directly against Date.now() in JS. The
            // app treats old payloads as abandoned and clears them unused.
            defaults.set(Date().timeIntervalSince1970 * 1000, forKey: Self.tsKey)

            self.openMainApp()
            // Give the openURL call a beat to land in the host before this
            // process is torn down; completing immediately can drop it.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                self.complete()
            }
        }
    }

    /// Share extensions can't call UIApplication.shared.open directly, so walk
    /// the responder chain up to the UIApplication and invoke openURL: on it —
    /// the long-standing pattern for opening the containing app from a share
    /// extension. Falls back to extensionContext.open for good measure.
    private func openMainApp() {
        guard let url = URL(string: Self.triggerURL) else { return }
        let selector = sel_registerName("openURL:")
        var responder: UIResponder? = self
        while let r = responder {
            if r.responds(to: selector), !(r is UIViewController) {
                r.perform(selector, with: url)
                return
            }
            responder = r.next
        }
        extensionContext?.open(url, completionHandler: nil)
    }

    private func complete() {
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }
}
