import NMCore
import SwiftUI

struct MosqueDetailView: View {
    @Environment(Localization.self) private var l10n
    @Environment(\.colorScheme) private var scheme
    @Environment(\.openURL) private var openURL
    let ranked: RankedMosque
    @State var favorite: Bool
    /// Only downloaded records can be favorites (live results have no stable record on the phone).
    let canFavorite: Bool
    let route: WalkingRoute?
    var onFavorite: (Bool) -> Void

    init(ranked: RankedMosque, favorite: Bool, canFavorite: Bool = true, route: WalkingRoute? = nil, onFavorite: @escaping (Bool) -> Void) {
        self.ranked = ranked
        self._favorite = State(initialValue: favorite)
        self.canFavorite = canFavorite
        self.route = route
        self.onFavorite = onFavorite
    }

    private var isApple: Bool { ranked.mosque.packId == OnlineMosques.applePackId }

    var body: some View {
        let m = ranked.mosque
        let name = m.displayName(l10n.language) ?? l10n.t("mosque_unnamed")
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(name).font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
                        ForEach(Array(Set(m.names.filter { $0.key != "default" }.values)).filter { $0 != name }.sorted().prefix(2), id: \.self) {
                            Text($0).font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    if canFavorite {
                    Button {
                        favorite.toggle(); onFavorite(favorite)
                    } label: {
                        Image(systemName: favorite ? "star.fill" : "star").foregroundStyle(favorite ? Theme.gold : .secondary).frame(width: 44, height: 44)
                    }
                    .accessibilityLabel(l10n.t(favorite ? "favorite_remove" : "favorite_add"))
                    }
                }
                Text(l10n.t(m.category == .prayer_space ? "category_prayer_space" : "category_mosque") + " · " + l10n.t("straight_line", Format.distance(ranked.distanceMeters, l10n: l10n)))
                if let route {
                    Label(l10n.t("walking_route", Format.distance(route.meters, l10n: l10n), l10n.t("minutes_short", Int((route.seconds / 60).rounded()))),
                          systemImage: "figure.walk").font(.subheadline)
                }
                if let a = m.address { Text(a).font(.subheadline) }
                Text(l10n.t("hours_unknown")).font(.subheadline).foregroundStyle(Theme.accentText(scheme))
                if let h = m.openingHoursRaw { Text(l10n.t("hours_listed", h)).font(.subheadline) }
                Text(l10n.t("hours_unverified_note")).font(.caption).foregroundStyle(.secondary)
                Button { ExternalMaps.directions(to: m.location, name: name) } label: {
                    Label(l10n.t("directions"), systemImage: "location.north.line.fill").frame(maxWidth: .infinity, minHeight: 44)
                }
                .prominentButton().padding(.top, 8)
                HStack {
                    Button { if let p = m.phone, let u = URL(string: "tel:" + p.filter { $0.isNumber || $0 == "+" }) { openURL(u) } } label: {
                        Label(l10n.t("call"), systemImage: "phone").frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .disabled(m.phone == nil)
                    Button { if let w = m.website, let u = URL(string: w.hasPrefix("http") ? w : "https://" + w) { openURL(u) } } label: {
                        Label(l10n.t("website"), systemImage: "globe").frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .disabled(m.website == nil)
                }
                .glassButton()
                Text(l10n.t("external_maps_note")).font(.caption).foregroundStyle(.secondary)
                if isApple {
                    Text(l10n.t("source_online_apple")).font(.caption).foregroundStyle(.secondary)
                } else {
                    Text(l10n.t("record_source", "OpenStreetMap " + m.sourceId.replacingOccurrences(of: "osm:", with: ""), String((m.sourceTimestamp ?? "").prefix(10))))
                        .font(.caption).foregroundStyle(.secondary)
                    Text(l10n.t("data_attribution_osm")).font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(20)
        }
    }
}
