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
// This file is NOT a compile source until ios/VOICE_CAPTURE_SETUP.md adds it
// to the App target (v1.3). Until then main builds exactly as before.
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

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$text) to Nubble")
    }

    private static let log = Logger(subsystem: "com.adamlai.flownotes.VoiceCapture", category: "intent")

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw $text.needsValueError("What's the note?")
        }
        do {
            let id = try VoiceCaptureStore.append(trimmed)
            Self.log.notice("intent stored capture \(id, privacy: .public) (\(trimmed.count, privacy: .public) chars)")
        } catch {
            // Siri reads errorDescription aloud, so VoiceCaptureError's copy
            // must make sense spoken.
            Self.log.error("intent failed to store capture: \(String(describing: error), privacy: .public)")
            throw error
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
                "Add a note to \(.applicationName)",
                "Add a note in \(.applicationName)",
                "New note in \(.applicationName)",
                "Take a note in \(.applicationName)",
                "Note in \(.applicationName)",
            ],
            shortTitle: "Add a Note",
            systemImageName: "mic.fill"
        )
    }
}
