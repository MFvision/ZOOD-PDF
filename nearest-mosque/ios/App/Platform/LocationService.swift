import CoreLocation
import NMCore
import UIKit

/// "You are here". Never substituted with a default city.
struct DevicePosition: Equatable {
    let location: LatLng
    let accuracyMeters: Double?
    let timestamp: Date
}

/// Foreground location (when-in-use) and true heading through Core Location. Heading updates run
/// only while a Qibla view is visible; GNSS works without a data connection.
@MainActor
@Observable
final class LocationService: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var pending: [CheckedContinuation<DevicePosition?, Never>] = []
    private var headingUsers = 0
    private var smoother = HeadingSmoother()

    private(set) var authorization: CLAuthorizationStatus = .notDetermined
    private(set) var compass: CompassState = .bearingOnly
    var position: DevicePosition?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        manager.headingFilter = 1
        authorization = manager.authorizationStatus
        if let l = manager.location { position = Self.convert(l) }
    }

    var isDenied: Bool { authorization == .denied || authorization == .restricted }
    var isAuthorized: Bool { authorization == .authorizedWhenInUse || authorization == .authorizedAlways }
    var headingAvailable: Bool { CLLocationManager.headingAvailable() }

    /// Asks for permission if needed (at the point of use) and returns one fix, or nil.
    func currentPosition() async -> DevicePosition? {
        if authorization == .notDetermined { manager.requestWhenInUseAuthorization() }
        if isDenied { return nil }
        return await withCheckedContinuation { cont in
            pending.append(cont)
            if isAuthorized { manager.requestLocation() }
            // Give up after 20 s; the caller then offers a city instead.
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(20))
                self.finish(nil)
            }
        }
    }

    private func finish(_ p: DevicePosition?) {
        let waiting = pending
        pending.removeAll()
        if let p { position = p }
        waiting.forEach { $0.resume(returning: p ?? position.flatMap { Date().timeIntervalSince($0.timestamp) < 1800 ? $0 : nil }) }
    }

    func beginHeading() {
        headingUsers += 1
        guard headingUsers == 1, CLLocationManager.headingAvailable() else { return }
        smoother.reset()
        updateOrientation()
        manager.startUpdatingHeading()
    }

    func endHeading() {
        headingUsers = max(0, headingUsers - 1)
        if headingUsers == 0 {
            manager.stopUpdatingHeading()
            compass = .bearingOnly
        }
    }

    func updateOrientation() {
        switch UIDevice.current.orientation {
        case .landscapeLeft: manager.headingOrientation = .landscapeLeft
        case .landscapeRight: manager.headingOrientation = .landscapeRight
        case .portraitUpsideDown: manager.headingOrientation = .portraitUpsideDown
        case .faceUp: manager.headingOrientation = .faceUp
        default: manager.headingOrientation = .portrait
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        let status = m.authorizationStatus
        Task { @MainActor in
            self.authorization = status
            if self.isAuthorized, !self.pending.isEmpty { self.manager.requestLocation() }
            if self.isDenied { self.finish(nil) }
        }
    }

    nonisolated func locationManager(_ m: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let l = locations.last else { return }
        Task { @MainActor in self.finish(Self.convert(l)) }
    }

    nonisolated func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in self.finish(nil) }
    }

    nonisolated func locationManager(_ m: CLLocationManager, didUpdateHeading h: CLHeading) {
        let trueHeading = h.trueHeading
        let accuracy = h.headingAccuracy
        Task { @MainActor in
            // trueHeading < 0 means Core Location could not correct for declination (no location):
            // never present magnetic heading as true heading.
            guard trueHeading >= 0, accuracy >= 0 else { self.compass = .bearingOnly; return }
            let smoothed = self.smoother.update(trueHeading)
            self.compass = .live(headingTrue: smoothed, accuracyDeg: accuracy, needsCalibration: accuracy > 25)
        }
    }

    /// Calm in-app guidance replaces the system calibration overlay.
    nonisolated func locationManagerShouldDisplayHeadingCalibration(_ m: CLLocationManager) -> Bool { false }

    nonisolated static func convert(_ l: CLLocation) -> DevicePosition? {
        guard let ll = LatLng(l.coordinate.latitude, l.coordinate.longitude) else { return nil }
        return DevicePosition(location: ll, accuracyMeters: l.horizontalAccuracy >= 0 ? l.horizontalAccuracy : nil, timestamp: l.timestamp)
    }
}
