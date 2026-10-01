import AVFoundation
import SwiftUI

/// The bar under the page while the document is read aloud: the sentence
/// being read, previous / play-pause / next, the speed, and Stop.
struct ReadAloudBar: View {
    @Bindable var reader: ReadAloudController
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: Space.x3) {
            HStack(alignment: .top, spacing: Space.x3) {
                Image(systemName: "waveform")
                    .foregroundStyle(.tint)
                    .symbolEffect(.variableColor.iterative, isActive: reader.state == .playing && !reduceMotion)
                Text(reader.currentSentence?.text ?? String(localized: "Reading…"))
                    .font(TextStyle.callout)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("readAloud.sentence")
            }
            HStack(spacing: Space.x5) {
                Button("Previous sentence", systemImage: "backward.fill") { reader.previous() }
                    .accessibilityIdentifier("readAloud.previous")
                Button(reader.state == .playing ? "Pause" : "Play", systemImage: reader.state == .playing ? "pause.fill" : "play.fill") {
                    reader.togglePlayPause()
                }
                .font(.title2)
                .accessibilityIdentifier("readAloud.playPause")
                Button("Next sentence", systemImage: "forward.fill") { reader.next() }
                    .accessibilityIdentifier("readAloud.next")
                Spacer()
                speedMenu
                Button("Stop", systemImage: "xmark.circle.fill") { reader.stop() }
                    .accessibilityIdentifier("readAloud.stop")
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.pressable)
            .disabled(reader.state == .loading)
        }
        .padding(.horizontal, Space.x5)
        .padding(.vertical, Space.x4)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("readAloud.bar")
        .sensoryFeedback(.selection, trigger: reader.index)
    }

    /// The speed, as multiples of the system's default rate.
    private var speedMenu: some View {
        Menu {
            ForEach(Self.speeds) { speed in
                Button {
                    reader.rate = speed.rate
                } label: {
                    if abs(reader.rate - speed.rate) < 0.01 {
                        Label(speed.title, systemImage: "checkmark")
                    } else {
                        Text(speed.title)
                    }
                }
            }
        } label: {
            Text(Self.speeds.min { abs($0.rate - reader.rate) < abs($1.rate - reader.rate) }?.title ?? "1×")
                .font(TextStyle.callout.weight(.semibold))
                .tabularNumbers()
                .padding(.horizontal, Space.x3)
                .padding(.vertical, Space.x2)
                .background(Surface.groupedCell, in: Capsule())
        }
        .accessibilityLabel(Text("Speed"))
        .accessibilityIdentifier("readAloud.speed")
    }

    /// Slower and faster than the system's default, within what the
    /// synthesizer allows.
    static let speeds: [Speed] = [0.75, 1.0, 1.25, 1.5, 2.0].map { factor in
        Speed(factor: factor,
              title: "\(factor.formatted(.number.precision(.fractionLength(0...2))))×",
              rate: min(AVSpeechUtteranceDefaultSpeechRate * Float(factor), AVSpeechUtteranceMaximumSpeechRate))
    }

    /// A speed: a multiple of the system's default rate, and the rate.
    struct Speed: Identifiable, Sendable {
        let factor: Double
        let title: String
        let rate: Float
        var id: Double { factor }
    }
}
