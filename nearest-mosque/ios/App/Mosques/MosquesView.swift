import NMCore
import NMData
import SwiftUI
import UIKit

/// Where the list is measured from. Selecting a point never moves "you are here".
enum SearchOrigin: Equatable { case device, prayerCity(String), selectedPoint }

@MainActor
@Observable
final class MosquesModel {
    var origin: SearchOrigin?
    var center: LatLng?
    var loading = false
    var result: MosqueResult?
    var favorites: Set<String> = []
    private let generation = SearchGeneration()
    private var task: Task<Void, Never>?

    /// Cancels any search in flight; an older, slower result can never overwrite a newer one.
    func search(_ app: AppModel, center: LatLng, origin: SearchOrigin) {
        guard let repo = app.mosques else { return }
        let gen = generation.next()
        task?.cancel()
        self.center = center
        self.origin = origin
        loading = true
        let lang = app.l10n.language
        task = Task {
            let r = try? await Task.detached { try repo.nearest(center, radiusMeters: 25_000, lang: lang) }.value
            guard !Task.isCancelled, generation.isCurrent(gen) else { return }
            result = r
            loading = false
        }
    }

    func refreshFavorites(_ app: AppModel) { favorites = (try? app.mosques?.favorites()) ?? [] }
}

struct MosquesView: View {
    @Environment(AppModel.self) private var app
    @Environment(Localization.self) private var l10n
    @Environment(\.colorScheme) private var scheme
    @Binding var showSettings: Bool
    @State private var vm = MosquesModel()
    @State private var mode = 0
    @State private var favoritesOnly = false
    @State private var selected: RankedMosque?
    @State private var locating = false
    @State private var denied = false

    var body: some View {
        VStack(spacing: 8) {
            HStack {
                Picker("", selection: $mode) {
                    Label(l10n.t("view_list"), systemImage: "list.bullet").tag(0)
                    Label(l10n.t("view_map"), systemImage: "map").tag(1)
                }
                .pickerStyle(.segmented)
                Toggle(isOn: $favoritesOnly) { Label(l10n.t("favorites"), systemImage: "star") }
                    .toggleStyle(.button)
            }
            .padding(.horizontal)
            originRow
            content
        }
        .navigationTitle(l10n.t("tab_mosques"))
        .toolbar { ToolbarItem(placement: .topBarTrailing) { SettingsButton(show: $showSettings) } }
        .task(id: app.ready) { start() }
        .onAppear { vm.refreshFavorites(app) }
        .sheet(item: $selected) { r in
            MosqueDetailView(ranked: r, favorite: vm.favorites.contains(r.id)) { on in
                try? app.mosques?.setFavorite(r.id, on)
                vm.refreshFavorites(app)
            }
            .presentationDetents([.medium, .large])
        }
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

    @ViewBuilder private var originRow: some View {
        if let o = vm.origin {
            HStack {
                switch o {
                case .device: Text(l10n.t("searching_from_you"))
                case let .prayerCity(name): Text(l10n.t("searching_from_city", name))
                case .selectedPoint: Text(l10n.t("searching_from_point"))
                }
                Spacer()
                if o != .device {
                    Button(action: useDevice) { Label(l10n.t("recenter"), systemImage: "location") }.buttonStyle(.bordered)
                }
            }
            .font(.subheadline).foregroundStyle(.secondary)
            .padding(.horizontal)
        }
    }

    @ViewBuilder private var content: some View {
        if favoritesOnly {
            let favs = (try? app.mosques?.byIds(Array(vm.favorites))) ?? []
            List(favs) { m in
                let d = vm.center.map { Geo.distanceMeters($0, m.location) }
                MosqueRow(mosque: m, distance: d, favorite: true).onTapGesture { selected = RankedMosque(mosque: m, distanceMeters: d ?? 0) }
            }
            .listStyle(.plain)
        } else if vm.center == nil {
            VStack(alignment: .leading, spacing: 12) {
                Text(l10n.t("mosques_need_location_title")).font(.title3.weight(.semibold))
                Text(l10n.t(denied ? "location_denied" : "mosques_need_location_body"))
                Button(action: useDevice) { Text(l10n.t(locating ? "locating" : "allow_location")).frame(maxWidth: .infinity, minHeight: 44) }
                    .prominentButton().disabled(locating)
                if let loc = app.settings.location {
                    Button { vm.search(app, center: loc.location, origin: .prayerCity(loc.name)) } label: {
                        Text(l10n.t("use_prayer_city", loc.name)).frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.bordered)
                }
            }
            .card().padding(.horizontal)
            Spacer()
        } else if vm.loading && vm.result == nil {
            ProgressView().frame(maxHeight: .infinity)
        } else {
            switch vm.result {
            case let .found(items, _):
                if mode == 0 { list(items) } else {
                    OfflinePlot(center: vm.center!, items: items, device: app.location.position?.location,
                                onSelect: { selected = $0 }, onSearchHere: { vm.search(app, center: $0, origin: .selectedPoint) })
                }
            case let .noRecordsInCoverage(name, radius):
                empty(l10n.t("no_records_title"), l10n.t("no_records_body", name, Format.distance(radius, l10n: l10n)))
            case let .areaNotDownloaded(installed):
                empty(l10n.t("region_not_downloaded_title"),
                      l10n.t("region_not_downloaded_body", installed.isEmpty ? l10n.t("region_none_installed") : ListFormatter.localizedString(byJoining: installed)))
            case nil:
                Spacer()
            }
        }
    }

    private func empty(_ title: String, _ body: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.headline).accessibilityAddTraits(.isHeader)
            Text(body).font(.subheadline)
        }
        .card().padding(.horizontal).frame(maxHeight: .infinity, alignment: .top)
    }

    private func list(_ items: [RankedMosque]) -> some View {
        List {
            if let first = items.first {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(l10n.t("nearest_known_mosque")).font(.footnote.weight(.semibold)).foregroundStyle(Theme.accentText(scheme))
                        Text(first.mosque.displayName(l10n.language) ?? l10n.t("mosque_unnamed")).font(.title3.weight(.semibold))
                        Text(l10n.t("straight_line", Format.distance(first.distanceMeters, l10n: l10n)))
                        if let a = first.mosque.address { Text(a).font(.subheadline).foregroundStyle(.secondary) }
                        HStack {
                            Button { ExternalMaps.directions(to: first.mosque.location, name: first.mosque.displayName(l10n.language)) } label: {
                                Label(l10n.t("directions"), systemImage: "location.north.line.fill").frame(maxWidth: .infinity, minHeight: 44)
                            }
                            .prominentButton()
                            Button(l10n.t("show_more_detail")) { selected = first }.buttonStyle(.bordered)
                        }
                        .padding(.top, 6)
                    }
                    .padding(.vertical, 6)
                }
            }
            Section(l10n.plural("mosque_count", items.count)) {
                ForEach(items.dropFirst()) { r in
                    Button { selected = r } label: {
                        MosqueRow(mosque: r.mosque, distance: r.distanceMeters, favorite: vm.favorites.contains(r.id))
                    }
                    .foregroundStyle(.primary)
                }
            }
            Section { Text(l10n.t("data_attribution_osm")).font(.caption).foregroundStyle(.secondary) }
        }
        .listStyle(.insetGrouped)
    }
}

struct MosqueRow: View {
    @Environment(Localization.self) private var l10n
    let mosque: Mosque
    let distance: Double?
    let favorite: Bool

    var body: some View {
        let name = mosque.displayName(l10n.language) ?? l10n.t("mosque_unnamed")
        let dist = distance.map { Format.distance($0, l10n: l10n) } ?? ""
        HStack(spacing: 12) {
            Image(systemName: "building.columns.fill").foregroundStyle(Theme.navy).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.body.weight(.medium)).lineLimit(2)
                let sub = [mosque.category == .prayer_space ? l10n.t("category_prayer_space") : nil, mosque.address].compactMap { $0 }.joined(separator: " · ")
                if !sub.isEmpty { Text(sub).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            }
            Spacer()
            if favorite { Image(systemName: "star.fill").foregroundStyle(Theme.gold).accessibilityHidden(true) }
            Text(dist).monospacedDigit().foregroundStyle(Theme.navy)
        }
        .frame(minHeight: 48)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(l10n.t("mosque_detail_a11y", name, dist))
    }
}

/// Offline view without map tiles: north-up, distance rings, pins by local projection. Drag to move
/// the search point; "Search this area" re-runs the list there. The device marker stays real.
struct OfflinePlot: View {
    @Environment(Localization.self) private var l10n
    let center: LatLng
    let items: [RankedMosque]
    let device: LatLng?
    var onSelect: (RankedMosque) -> Void
    var onSearchHere: (LatLng) -> Void
    @State private var pan: CGSize = .zero
    @GestureState private var drag: CGSize = .zero

    private var maxDist: Double { max(500, items.map(\.distanceMeters).max() ?? 1000) * 1.1 }

    private func project(_ p: LatLng, half: CGFloat) -> CGPoint {
        let scale = half / maxDist
        let dy = (p.latitude - center.latitude) * 111_320
        let dx = (p.longitude - center.longitude) * 111_320 * cos(center.latitude * .pi / 180)
        return CGPoint(x: half + dx * scale + pan.width + drag.width, y: half - dy * scale + pan.height + drag.height)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            GeometryReader { geo in
                let half = min(geo.size.width, geo.size.height) / 2
                ZStack {
                    ForEach(1...3, id: \.self) { k in
                        Circle().stroke(Color.primary.opacity(0.15)).frame(width: half * 2 * CGFloat(k) / 3, height: half * 2 * CGFloat(k) / 3)
                            .position(x: half + pan.width + drag.width, y: half + pan.height + drag.height)
                    }
                    Text(l10n.t("compass_north")).font(.caption.bold()).position(x: half, y: 8)
                    ForEach(items) { r in
                        Button { onSelect(r) } label: {
                            Circle().fill(r.id == items.first?.id ? Theme.gold : Theme.navy).frame(width: 14, height: 14)
                                .overlay(Circle().stroke(.white, lineWidth: 2)).frame(width: 44, height: 44)
                        }
                        .position(project(r.mosque.location, half: half))
                        .accessibilityLabel(r.mosque.displayName(l10n.language) ?? l10n.t("mosque_unnamed"))
                    }
                    if let d = device {
                        Circle().fill(Color.blue).frame(width: 12, height: 12).background(Circle().fill(Color.blue.opacity(0.25)).frame(width: 28, height: 28))
                            .position(project(d, half: half)).accessibilityHidden(true)
                    }
                }
                .frame(width: half * 2, height: half * 2)
                .contentShape(Rectangle())
                .gesture(DragGesture().updating($drag) { v, s, _ in s = v.translation }.onEnded { v in
                    pan.width += v.translation.width; pan.height += v.translation.height
                })
                .environment(\.layoutDirection, .leftToRight)
                .onChange(of: geo.size) { _, _ in pan = .zero }
                .overlay(alignment: .bottom) {
                    if pan != .zero {
                        Button(l10n.t("search_this_area")) {
                            let metersPerPoint = maxDist / half
                            let east = -pan.width * metersPerPoint, north = pan.height * metersPerPoint
                            let lat = min(90, max(-90, center.latitude + north / 111_320))
                            var lng = center.longitude + east / (111_320 * max(1e-6, cos(center.latitude * .pi / 180)))
                            lng = (lng + 540).truncatingRemainder(dividingBy: 360) - 180
                            if let p = LatLng(lat, lng) { pan = .zero; onSearchHere(p) }
                        }
                        .prominentButton().padding(.bottom, 8)
                    }
                }
            }
            .aspectRatio(1, contentMode: .fit)
            Text(l10n.t("map_offline_plot")).font(.caption).foregroundStyle(.secondary)
        }
        .padding()
        .frame(maxHeight: .infinity, alignment: .top)
    }
}

enum ExternalMaps {
    /// Opens Apple Maps for directions (outside this app's offline guarantee).
    static func directions(to p: LatLng, name: String?) {
        var c = URLComponents(string: "https://maps.apple.com/")!
        c.queryItems = [URLQueryItem(name: "daddr", value: "\(p.latitude),\(p.longitude)"), URLQueryItem(name: "q", value: name ?? "")]
        if let url = c.url { UIApplication.shared.open(url) }
    }
}
