import AppIntents
import Foundation
import os.log

// ── Siri / Shortcuts voice capture ──────────────────────────────────────────
//
// "Add a note to Nubble" — an App Intent that takes a line of text and drops
// it into the App Group capture queue (VoiceCaptureStore, defined in
// App/App/SceneDelegate.swift). The web layer (src/lib/voiceCapture.js) turns
// queued captures into root-level notes the next time it is ready to.
//
// This file is compiled into the App target itself (NOT an extension). With
// openAppWhenRun = false, iOS runs perform() in the background: if Nubble is
// not running it is launched WITHOUT a scene — no window, no WKWebView, no
// React — writes the capture, and suspends again. If Nubble is already
// running, perform() runs inside that process and VoiceCaptureStore's
// notification lets VoiceCapturePlugin hand the capture to the web layer at
// once. Either way the user never leaves Siri.
//
// This file sits beside SceneDelegate.swift but is a compile source only once
// ios/VOICE_CAPTURE_SETUP.md (Part B) adds it — and BubbleEntity.swift — to the
// App target (v1.3). Until then main builds exactly as before. THIS is the
// compiled copy: there is no other.
//
// Logging: filter Console.app on subsystem com.adamlai.flownotes.VoiceCapture.
// Only lengths and ids are logged, never the spoken text.

@available(iOS 16.0, *)
struct AddNoteIntent: AppIntent {
    static var title: LocalizedStringResource = "Add a Note"
    static var description = IntentDescription(
        "Saves what you say as a new note in Nubble. The note lands at the top level of your current project — you can move it into a bubble later."
    )

    // Capture only. Never bring the app forward: speaking a note should feel
    // like it landed the instant Siri says so.
    static var openAppWhenRun: Bool = false

    // When the phrase carries no text ("Add a note to Nubble"), Siri asks this
    // and takes the spoken answer — that is the voice-capture path.
    @Parameter(title: "Note", requestValueDialog: "What's the note?")
    var text: String

    // OPTIONAL, and never prompted for: the plain phrase leaves it nil and
    // the note lands at root exactly as before. Siri fills it only when the
    // spoken phrase named a bubble (see BubbleEntity.swift for how names
    // resolve and why resolution can never block the capture).
    @Parameter(title: "Bubble")
    var bubble: BubbleEntity?

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$text) to Nubble") {
            \.$bubble
        }
    }

    private static let log = Logger(subsystem: "com.adamlai.flownotes.VoiceCapture", category: "intent")

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw $text.needsValueError("What's the note?")
        }
        // Filing hints ride along with the capture; the app decides. A real
        // id files into that bubble if it still exists. A placeholder (name
        // Siri couldn't match against the mirror) carries only the name, and
        // the app files by name if such a bubble exists by then, else root.
        let bubbleId: String? = (bubble?.isPlaceholder ?? true) ? nil : bubble?.id
        let bubbleName: String? = bubble?.name
        do {
            let id = try VoiceCaptureStore.append(trimmed, bubbleId: bubbleId, bubbleName: bubbleName)
            Self.log.notice("intent stored capture \(id, privacy: .public) (\(trimmed.count, privacy: .public) chars, bubble: \(bubbleId == nil ? (bubbleName == nil ? "none" : "by-name") : "by-id", privacy: .public))")
        } catch {
            // Siri reads errorDescription aloud, so VoiceCaptureError's copy
            // must make sense spoken.
            Self.log.error("intent failed to store capture: \(String(describing: error), privacy: .public)")
            throw error
        }
        // The spoken confirmation is the user's proof the capture landed —
        // and where. Its ABSENCE is the tell that Siri never ran the intent.
        if let bubble = bubble, !bubble.isPlaceholder {
            return .result(dialog: "Added to \(bubble.name)")
        }
        return .result(dialog: "Added to Nubble")
    }
}

/// The phrases Siri listens for, available the moment the app is installed —
/// no Shortcuts setup, no first launch. `.applicationName` matches the
/// display name ("Nubble") AND every entry in Info.plist's
/// INAlternativeAppNames (also "Nubble", so the phrase survives a display
/// name change).
@available(iOS 16.0, *)
struct NubbleShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AddNoteIntent(),
            phrases: [
                // Plain capture → root.
                "Add a note to \(.applicationName)",
                "Add a note in \(.applicationName)",
                "New note in \(.applicationName)",
                "Take a note in \(.applicationName)",
                "Note in \(.applicationName)",
                // Filed capture. Siri precomputes one variant per mirrored
                // bubble, which is why the mirror is filtered and capped.
                "Add a note to \(\.$bubble) in \(.applicationName)",
                "Add a note in \(\.$bubble) in \(.applicationName)",
                "New note in \(\.$bubble) in \(.applicationName)",
                "Add a \(.applicationName) note to \(\.$bubble)",
                "Note in \(\.$bubble) in \(.applicationName)",
            ],
            shortTitle: "Add a Note",
            systemImageName: "mic.fill"
        )
    }
}
