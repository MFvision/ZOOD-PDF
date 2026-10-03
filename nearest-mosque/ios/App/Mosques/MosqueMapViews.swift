import MapKit
import NMCore
import SwiftUI

extension LatLng {
    var coordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: latitude, longitude: longitude) }
}

/// Live mosque results from Apple Maps (online, no API key). Only a rounded centre is used for the
/// search region; results are filtered to places whose name says mosque/masjid in common languages.
enum AppleMosqueSearch {
    private static let queries = ["mosque", "masjid", "مسجد"]
    private static let keywords = ["mosque", "masjid", "masjed", "musalla", "musallah", "jamia", "jami", "islamic", "مسجد", "جامع", "مصلى",
                                   "cami", "mescit", "mosquée", "mosquee", "mezquita", "moschee", "moskee", "مسجد"]

    /// nil when every request failed (offline or service unavailable).
    static func search(center: LatLng, radiusMeters: Double) async -> [Mosque]? {
        let c = OnlineMosques.privacyRound(center)
        let span = (radiusMeters + Double(OnlineMosques.roundingSlackMeters)) * 2
        let region = MKCoordinateRegion(center: c.coordinate, latitudinalMeters: span, longitudinalMeters: span)
        return await withTaskGroup(of: [Mosque]?.self) { group in
            for q in queries {
                group.addTask {
                    let request = MKLocalSearch.Request()
                    request.naturalLanguageQuery = q
                    request.region = region
                    request.resultTypes = .pointOfInterest
                    guard let response = try? await MKLocalSearch(request: request).start() else { return nil }
                    return response.mapItems.compactMap(convert)
                }
            }
            var all: [Mosque] = []
            var succeeded = false
            for await items in group {
                if let items { succeeded = true; all += items }
            }
            return succeeded ? all : nil
        }
    }

    static func convert(_ item: MKMapItem) -> Mosque? {
        guard let name = item.name, matches(name) else { return nil }
        let coord = item.placemark.coordinate
        guard let loc = LatLng(coord.latitude, coord.longitude) else { return nil }
        let id = "apple:\(Int((loc.latitude * 1e5).rounded())),\(Int((loc.longitude * 1e5).rounded()))"
        return Mosque(sourceId: id, packId: OnlineMosques.applePackId, category: .mosque, names: ["default": name], location: loc,
                      address: item.placemark.title, phone: item.phoneNumber, website: item.url?.absoluteString,
                      openingHoursRaw: nil, sourceTimestamp: nil)
    }

    static func matches(_ name: String) -> Bool {
        let n = name.lowercased()
        return keywords.contains { n.contains($0) }
    }
}

struct WalkingRoute: Equatable {
    let meters: Double
    let seconds: TimeInterval
    let polyline: MKPolyline
}

/// Walking routes from Apple Maps (online). Cached per destination for the session.
@MainActor
final class RouteService {
    private var cache: [String: WalkingRoute] = [:]

    func walking(from: LatLng, to mosque: Mosque) async -> WalkingRoute? {
        if let r = cache[mosque.id] { return r }
        let request = MKDirections.Request()
        request.source = MKMapItem(placemark: MKPlacemark(coordinate: from.coordinate))
        request.destination = MKMapItem(placemark: MKPlacemark(coordinate: mosque.location.coordinate))
        request.transportType = .walking
        guard let route = try? await MKDirections(request: request).calculate().routes.first else { return nil }
        let r = WalkingRoute(meters: route.distance, seconds: route.expectedTravelTime, polyline: route.polyline)
        cache[mosque.id] = r
        return r
    }
}

/// Pin in the website's style: navy disc with a white mosque, gold when nearest or selected.
struct MosquePin: View {
    let highlighted: Bool
    var size: CGFloat = 38
    var body: some View {
        ZStack {
            Circle().fill(highlighted ? Theme.gold : Theme.navy)
            MosqueGlyph().fill(.white).padding(size * 0.24)
        }
        .frame(width: size, height: size)
        .overlay(Circle().stroke(.white, lineWidth: 3))
        .shadow(color: highlighted ? Theme.gold.opacity(0.7) : .black.opacity(0.3), radius: highlighted ? 10 : 4, y: 2)
        .scaleEffect(highlighted ? 1.15 : 1)
        .animation(.spring(response: 0.3, dampingFraction: 0.6), value: highlighted)
    }
}

/// Live street map (Apple Maps; needs internet for the map images, pins always show).
struct MosqueMap: View {
    @Environment(Localization.self) private var l10n
    let items: [RankedMosque]
    let center: LatLng
    let route: WalkingRoute?
    @Binding var selection: String?
    var onSearchHere: (LatLng) -> Void
    @State private var camera: MapCameraPosition
    @State private var visible: CLLocationCoordinate2D?

    init(items: [RankedMosque], center: LatLng, route: WalkingRoute?, selection: Binding<String?>, onSearchHere: @escaping (LatLng) -> Void) {
        self.items = items; self.center = center; self.route = route; self._selection = selection; self.onSearchHere = onSearchHere
        let span = max(1500, min(20_000, (items.prefix(6).map(\.distanceMeters).max() ?? 2000) * 2.6))
        _camera = State(initialValue: .region(MKCoordinateRegion(center: center.coordinate, latitudinalMeters: span, longitudinalMeters: span)))
    }

    private var moved: Bool {
        guard let v = visible, let p = LatLng(v.latitude, v.longitude) else { return false }
        return Geo.distanceMeters(p, center) > 400
    }

    var body: some View {
        Map(position: $camera, selection: $selection) {
            UserAnnotation()
            ForEach(items.prefix(60)) { r in
                Annotation(r.mosque.displayName(l10n.language) ?? l10n.t("mosque_unnamed"), coordinate: r.mosque.location.coordinate, anchor: .center) {
                    MosquePin(highlighted: selection == r.id || (selection == nil && r.id == items.first?.id))
                }
                .tag(r.id)
            }
            if let route {
                MapPolyline(route.polyline).stroke(Theme.gold, style: StrokeStyle(lineWidth: 5, lineCap: .round, dash: [1, 9]))
            }
        }
        .mapStyle(.standard(elevation: .realistic, emphasis: .muted, pointsOfInterest: .excludingAll))
        .mapControls {
            MapUserLocationButton()
            MapCompass()
            MapScaleView()
        }
        .onMapCameraChange(frequency: .onEnd) { ctx in visible = ctx.region.center }
        .overlay(alignment: .bottom) {
            if moved, let v = visible, let p = LatLng(v.latitude, v.longitude) {
                Button { onSearchHere(p) } label: { Label(l10n.t("search_this_area"), systemImage: "magnifyingglass") }
                    .prominentButton()
                    .padding(.bottom, 12)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(Theme.spring, value: moved)
        .environment(\.layoutDirection, .leftToRight)
    }
}

/// Compass view of nearby mosques: you in the centre, each mosque at its true bearing and (square-
/// root scaled) distance. With a live heading the dial turns so the top is where the phone points
/// and "Mosque ahead" appears when the nearest one is in front. Without heading it is north-up.
struct MosqueRadar: View {
    @Environment(Localization.self) private var l10n
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let items: [RankedMosque]
    let center: LatLng
    let heading: Double?
    var selected: String?
    var onSelect: (RankedMosque) -> Void
    @State private var rotation: Double = 0

    var body: some View {
        GeometryReader { geo in
            let s = min(geo.size.width, geo.size.height)
            let shown = Array(items.prefix(10))
            let maxD = max(300, shown.map(\.distanceMeters).max() ?? 1000)
            let usable = s / 2 - 28
            ZStack {
                Circle().fill(.clear).glass(Circle())
                ForEach(1...2, id: \.self) { k in
                    Circle().stroke(.white.opacity(0.16), lineWidth: 1).frame(width: s * CGFloat(k) / 3, height: s * CGFloat(k) / 3)
                }
                ZStack {
                    ForEach(0..<36, id: \.self) { i in
                        Rectangle().fill(.white.opacity(i % 9 == 0 ? 0.8 : 0.3))
                            .frame(width: i % 9 == 0 ? 2 : 1, height: i % 9 == 0 ? 10 : 5)
                            .offset(y: -s / 2 + 10)
                            .rotationEffect(.degrees(Double(i) * 10))
                    }
                    Text(l10n.t("compass_north")).font(.caption.weight(.bold)).foregroundStyle(Color(hex: 0xF2B8B5)).offset(y: -s / 2 + 26)
                    if let first = shown.first {
                        let p = point(first, maxD: maxD, usable: usable)
                        Path { path in
                            path.move(to: CGPoint(x: s / 2, y: s / 2))
                            path.addLine(to: CGPoint(x: s / 2 + p.x, y: s / 2 + p.y))
                        }
                        .stroke(Theme.gold, style: StrokeStyle(lineWidth: 3, lineCap: .round, dash: [6, 6]))
                    }
                    ForEach(shown) { r in
                        let p = point(r, maxD: maxD, usable: usable)
                        Button { onSelect(r) } label: {
                            MosquePin(highlighted: r.id == (selected ?? shown.first?.id), size: 34)
                                .rotationEffect(.degrees(-rotation))
                                .frame(width: 44, height: 44)
                        }
                        .buttonStyle(.plain)
                        .offset(x: p.x, y: p.y)
                        .accessibilityLabel(l10n.t("mosque_detail_a11y", r.mosque.displayName(l10n.language) ?? l10n.t("mosque_unnamed"), Format.distance(r.distanceMeters, l10n: l10n)))
                    }
                }
                .frame(width: s, height: s)
                .rotationEffect(.degrees(rotation))
                Circle().fill(Color(hex: 0x4F8EF7)).frame(width: 16, height: 16).overlay(Circle().stroke(.white, lineWidth: 3))
                if heading != nil {
                    Capsule().fill(.white).frame(width: 4, height: 14).offset(y: -s / 2 - 1)
                }
            }
            .frame(width: s, height: s)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .environment(\.layoutDirection, .leftToRight)
        .onAppear { rotation = -(heading ?? 0) }
        .onChange(of: heading) { _, h in
            let next = Angles.shortestTarget(current: rotation, target: -(h ?? 0))
            if reduceMotion { rotation = next } else { withAnimation(.interpolatingSpring(stiffness: 180, damping: 26)) { rotation = next } }
        }
    }

    private func point(_ r: RankedMosque, maxD: Double, usable: CGFloat) -> CGPoint {
        let b = Geo.initialBearing(from: center, to: r.mosque.location) * .pi / 180
        let rad = CGFloat((r.distanceMeters / maxD).squareRoot()) * usable
        return CGPoint(x: rad * CGFloat(sin(b)), y: -rad * CGFloat(cos(b)))
    }

    /// Guidance toward the nearest mosque when a live heading exists.
    static func guidance(items: [RankedMosque], center: LatLng, heading: Double?, l10n: Localization) -> String? {
        guard let h = heading, let first = items.first else { return nil }
        let rel = Angles.normalize180(Geo.initialBearing(from: center, to: first.mosque.location) - h)
        if abs(rel) <= 12 { return l10n.t("mosque_ahead") }
        let deg = Format.degrees(abs(rel), locale: l10n.locale)
        return rel > 0 ? l10n.t("qibla_turn_right", deg) : l10n.t("qibla_turn_left", deg)
    }
}
