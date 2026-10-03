import NMCore
import NMData
import SwiftUI
import UIKit

/// Where the list is measured from. Selecting a point never moves "you are here".
enum SearchOrigin: Equatable { case device, prayerCity(String), selectedPoint }

enum OnlineState: Equatable { case off, searching, done, unavailable }

@MainActor
@Observable
final class MosquesModel {
    var origin: SearchOrigin?
    var center: LatLng?
    var loading = false
    /// Downloaded-data outcome (keeps the distinct empty states).
    var result: MosqueResult?
    /// Downloaded records merged with live results, nearest first.
    var items: [RankedMosque] = []
    var online: OnlineState = .off
    var favorites: Set<String> = []
    var routes: [String: WalkingRoute] = [:]
    private let generation = SearchGeneration()
    private let routeService = RouteService()
    private var task: Task<Void, Never>?
    static let radius = 25_000.0

    /// Cancels any search in flight; an older, slower result can never overwrite a newer one.
    func search(_ app: AppModel, center: LatLng, origin: SearchOrigin) {
        guard let repo = app.mosques else { return }
        let gen = generation.next()
        task?.cancel()
        self.center = center
        self.origin = origin
        loading = true
        routes = [:]
        let lang = app.l10n.language
        let useOnline = app.settings.onlineSearch
        task = Task {
            let r = try? await Task.detached { try repo.nearest(center, radiusMeters: Self.radius, lang: lang) }.value
            guard !Task.isCancelled, generation.isCurrent(gen) else { return }
            result = r
            var offline: [RankedMosque] = []
            if case let .found(list, _) = r { offline = list }
            items = offline
            loading = false
            guard useOnline else { online = .off; await loadRoutes(app, gen); return }
            online = .searching
            let live = await AppleMosqueSearch.search(center: center, radiusMeters: 10_000)
            guard !Task.isCancelled, generation.isCurrent(gen) else { return }
            if let live {
                items = OnlineMosques.merge(center: center, offline: offline, online: live, radiusMeters: Self.radius)
                online = .done
            } else {
                online = .unavailable
            }
            await loadRoutes(app, gen)
        }
    }

    /// Walking routes for the closest few (online; silently skipped when unavailable).
    private func loadRoutes(_ app: AppModel, _ gen: Int) async {
        guard let from = app.location.position?.location, origin == .device else { return }
        for r in items.prefix(3) where r.distanceMeters < 6_000 {
            if let route = await routeService.walking(from: from, to: r.mosque), generation.isCurrent(gen) {
                routes[r.id] = route
            }
        }
    }

    func refreshFavorites(_ app: AppModel) { favorites = (try? app.mosques?.favorites()) ?? [] }
}

struct MosquesView: View {
    @Environment(AppModel.self) private var app
    @Environment(Localization.self) private var l10n
    @Binding var showSettings: Bool
    @State private var vm = MosquesModel()
    @State private var mode = UserDefaults.standard.integer(forKey: "demoMosqueMode")
    @State private var favoritesOnly = false
    @State private var selected: RankedMosque?
    @State private var mapSelection: String?
    @State private var locating = false
    @State private var denied = false

    private var heading: Double? {
        if case let .live(h, _, _) = app.location.compass { return h }
        return nil
    }

    var body: some View {
        VStack(spacing: 12) {
            header
            if let center = vm.center, !favoritesOnly, !vm.items.isEmpty {
                visual(center)
            }
            ScrollView {
                LazyVStack(spacing: 12) {
                    statusRow
                    content
                }
                .padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)
        }
        .padding(.horizontal, 16)
        .foregroundStyle(.white)
        .skyBackground(horizon: 0.42)
        .toolbar(.hidden, for: .navigationBar)
        .task(id: app.ready) { start() }
        .onAppear { vm.refreshFavorites(app); app.location.beginHeading() }
        .onDisappear { app.location.endHeading() }
        .onChange(of: mapSelection) { _, id in
            if let id, let r = vm.items.first(where: { $0.id == id }) { selected = r }
        }
        .sheet(item: $selected, onDismiss: { mapSelection = nil }) { r in
            MosqueDetailView(ranked: r, favorite: vm.favorites.contains(r.id), canFavorite: r.mosque.packId.hasPrefix("mosques."),
                             route: vm.routes[r.id]) { on in
                try? app.mosques?.setFavorite(r.id, on)
                vm.refreshFavorites(app)
            }
            .presentationDetents([.medium, .large])
        }
    }

    private var header: some View {
        VStack(spacing: 12) {
            HStack {
                GlassIconButton(systemImage: favoritesOnly ? "star.fill" : "star", label: l10n.t("favorites")) {
                    withAnimation(Theme.spring) { favoritesOnly.toggle() }
                }
                Spacer()
                Text(l10n.t("tab_mosques")).font(.headline)
                Spacer()
                SettingsButton(show: $showSettings)
            }
            if vm.center != nil, !favoritesOnly {
                GlassSegmented(selection: $mode, options: [
                    (l10n.t("view_compass"), "safari"),
                    (l10n.t("view_map"), "map"),
                ])
            }
        }
        .padding(.top, 4)
    }

    @ViewBuilder private func visual(_ center: LatLng) -> some View {
        Group {
            if mode == 0 {
                VStack(spacing: 8) {
                    MosqueRadar(items: vm.items, center: center, heading: heading, selected: nil) { selected = $0 }
                        .frame(maxHeight: 300)
                    if let g = MosqueRadar.guidance(items: vm.items, center: center, heading: heading, l10n: l10n) {
                        Text(g).font(.headline).foregroundStyle(g == l10n.t("mosque_ahead") ? Theme.gold : .white)
                            .accessibilityAddTraits(.updatesFrequently)
                    }
                }
            } else {
                MosqueMap(items: vm.items, center: center, route: vm.items.first.flatMap { vm.routes[$0.id] }, selection: $mapSelection) {
                    vm.search(app, center: $0, origin: .selectedPoint)
                }
                .id(center)
                .frame(height: 320)
                .clipShape(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).stroke(.white.opacity(0.25), lineWidth: 1))
            }
        }
        .transition(.opacity)
        .animation(Theme.spring, value: mode)
    }

    private func start() {
        guard app.ready, vm.center == nil else { return }
        if let p = app.location.position { vm.search(app, center: p.location, origin: .device) }
        else if let loc = app.settings.location { vm.search(app, center: loc.location, origin: .prayerCity(loc.name)) }
    }

    private func useDevice() {
        Task {
            locating = true
            let fix = await app.location.currentPosition()
            locating = false
            denied = app.location.isDenied
            if let fix { vm.search(app, center: fix.location, origin: .device) }
        }
    }

    @ViewBuilder private var statusRow: some View {
        if let o = vm.origin, !favoritesOnly {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    switch o {
                    case .device: Text(l10n.t("searching_from_you"))
                    case let .prayerCity(name): Text(l10n.t("searching_from_city", name))
                    case .selectedPoint: Text(l10n.t("searching_from_point"))
                    }
                    switch vm.online {
                    case .searching: Text(l10n.t("online_searching")).foregroundStyle(.white.opacity(0.7))
                    case .unavailable: Text(l10n.t("online_offline_note")).foregroundStyle(Theme.gold)
                    default: EmptyView()
                    }
                }
                .font(.footnote)
                Spacer()
                if o != .device {
                    Button(action: useDevice) { Label(l10n.t("recenter"), systemImage: "location.fill").font(.footnote) }.glassButton()
                }
            }
        }
    }

    @ViewBuilder private var content: some View {
        if favoritesOnly {
            let favs = (try? app.mosques?.byIds(Array(vm.favorites))) ?? []
            ForEach(favs) { m in
                let d = vm.center.map { Geo.distanceMeters($0, m.location) }
                let r = RankedMosque(mosque: m, distanceMeters: d ?? 0)
                MosqueCard(ranked: r, nearest: false, favorite: true, route: nil, showDistance: d != nil) { selected = r }
            }
        } else if vm.center == nil {
            VStack(alignment: .leading, spacing: 12) {
                Text(l10n.t("mosques_need_location_title")).font(.title3.weight(.semibold)).accessibilityAddTraits(.isHeader)
                Text(l10n.t(denied ? "location_denied" : "mosques_need_location_body")).foregroundStyle(.white.opacity(0.85))
                GlassGroup {
                    VStack(spacing: 10) {
                        Button(action: useDevice) {
                            Label(l10n.t(locating ? "locating" : "allow_location"), systemImage: "location.fill").frame(maxWidth: .infinity, minHeight: 32)
                        }
                        .prominentButton().disabled(locating)
                        if let loc = app.settings.location {
                            Button { vm.search(app, center: loc.location, origin: .prayerCity(loc.name)) } label: {
                                Text(l10n.t("use_prayer_city", loc.name)).frame(maxWidth: .infinity, minHeight: 32)
                            }
                            .glassButton()
                        }
                    }
                }
            }
            .glassCard(padding: 20)
        } else if vm.loading && vm.items.isEmpty {
            ProgressView().tint(.white).padding(.top, 40)
        } else if !vm.items.isEmpty {
            ForEach(Array(vm.items.prefix(40).enumerated()), id: \.element.id) { i, r in
                MosqueCard(ranked: r, nearest: i == 0, favorite: vm.favorites.contains(r.id), route: vm.routes[r.id], showDistance: true) { selected = r }
            }
            Text(attribution).font(.caption).foregroundStyle(.white.opacity(0.6)).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4)
        } else if vm.online != .searching {
            switch vm.result {
            case let .noRecordsInCoverage(name, radius):
                empty(l10n.t("no_records_title"), l10n.t("no_records_body", name, Format.distance(radius, l10n: l10n)))
            case let .areaNotDownloaded(installed):
                empty(l10n.t("region_not_downloaded_title"),
                      l10n.t("region_not_downloaded_body", installed.isEmpty ? l10n.t("region_none_installed") : ListFormatter.localizedString(byJoining: installed)))
            default:
                EmptyView()
            }
        }
    }

    private var attribution: String {
        var parts = [l10n.t("data_attribution_osm")]
        if vm.items.contains(where: { $0.mosque.packId == OnlineMosques.applePackId }) { parts.append(l10n.t("source_online_apple")) }
        return parts.joined(separator: " · ")
    }

    private func empty(_ title: String, _ body: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.headline).accessibilityAddTraits(.isHeader)
            Text(body).font(.subheadline).foregroundStyle(.white.opacity(0.85))
        }
        .glassCard()
    }
}

/// Glass mosque card: name, straight-line distance, walking route when known, one Directions button.
struct MosqueCard: View {
    @Environment(Localization.self) private var l10n
    let ranked: RankedMosque
    let nearest: Bool
    let favorite: Bool
    let route: WalkingRoute?
    let showDistance: Bool
    var onOpen: () -> Void

    var body: some View {
        let m = ranked.mosque
        let name = m.displayName(l10n.language) ?? l10n.t("mosque_unnamed")
        VStack(alignment: .leading, spacing: 10) {
            Button(action: onOpen) {
                HStack(spacing: 12) {
                    MosquePin(highlighted: nearest, size: 44)
                    VStack(alignment: .leading, spacing: 3) {
                        if nearest {
                            Text(l10n.t("nearest_known_mosque")).font(.caption.weight(.semibold)).foregroundStyle(Theme.gold)
                        }
                        Text(name).font(.headline).lineLimit(2).multilineTextAlignment(.leading)
                        if showDistance {
                            Text(l10n.t("straight_line", Format.distance(ranked.distanceMeters, l10n: l10n))).font(.subheadline).foregroundStyle(.white.opacity(0.8))
                        }
                        if let route {
                            Label(l10n.t("walking_route", Format.distance(route.meters, l10n: l10n), l10n.t("minutes_short", Int((route.seconds / 60).rounded()))),
                                  systemImage: "figure.walk")
                                .font(.footnote).foregroundStyle(.white.opacity(0.85))
                        }
                        if m.packId == OnlineMosques.applePackId {
                            Text(l10n.t("source_online_apple")).font(.caption2).foregroundStyle(.white.opacity(0.6))
                        } else if m.category == .prayer_space {
                            Text(l10n.t("category_prayer_space")).font(.caption2).foregroundStyle(.white.opacity(0.6))
                        }
                    }
                    Spacer(minLength: 4)
                    if favorite { Image(systemName: "star.fill").foregroundStyle(Theme.gold).accessibilityHidden(true) }
                    Image(systemName: l10n.isRTL ? "chevron.left" : "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.white.opacity(0.6))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(l10n.t("mosque_detail_a11y", name, Format.distance(ranked.distanceMeters, l10n: l10n)))
            Button { ExternalMaps.directions(to: m.location, name: name) } label: {
                Label(l10n.t("get_directions"), systemImage: "location.north.line.fill").frame(maxWidth: .infinity, minHeight: 28)
            }
            .modifier(DirectionsStyle(prominent: nearest))
        }
        .foregroundStyle(.white)
        .glassCard(padding: 14, tint: nearest ? Theme.gold.opacity(0.12) : nil)
    }
}

private struct DirectionsStyle: ViewModifier {
    let prominent: Bool
    func body(content: Content) -> some View {
        if prominent { content.prominentButton() } else { content.glassButton() }
    }
}

/// Two-option glass segmented control (Compass | Map) with a sliding gold-tinted thumb.
struct GlassSegmented: View {
    @Binding var selection: Int
    let options: [(String, String)]
    @Namespace private var ns

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(options.enumerated()), id: \.offset) { i, o in
                Button { withAnimation(Theme.spring) { selection = i } } label: {
                    Label(o.0, systemImage: o.1).font(.subheadline.weight(.semibold))
                        .foregroundStyle(selection == i ? Theme.navyNight : .white)
                        .frame(maxWidth: .infinity, minHeight: 40)
                        .background {
                            if selection == i { Capsule().fill(Theme.gold).matchedGeometryEffect(id: "thumb", in: ns) }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == i ? .isSelected : [])
            }
        }
        .padding(4)
        .glass(Capsule())
    }
}

enum ExternalMaps {
    /// Opens Apple Maps for directions (outside this app's offline guarantee).
    static func directions(to p: LatLng, name: String?) {
        var c = URLComponents(string: "https://maps.apple.com/")!
        c.queryItems = [URLQueryItem(name: "daddr", value: "\(p.latitude),\(p.longitude)"), URLQueryItem(name: "dirflg", value: "w"),
                        URLQueryItem(name: "q", value: name ?? "")]
        if let url = c.url { UIApplication.shared.open(url) }
    }
}
