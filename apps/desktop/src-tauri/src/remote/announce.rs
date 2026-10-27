//! The remote says where it is on the local network (Bonjour / mDNS), so the
//! ZOOD iPhone app finds this PC again by its name when its address changes,
//! without a new QR code. Only while the remote is on.
//!
//! It tells only what a phone on the same Wi-Fi could find by trying: the
//! PC's name, its address and the remote's port. No key goes out: a phone
//! still needs the pairing it got from a QR code to be let in.
//!
//! mdns-sd (Apache-2.0 OR MIT). A network that will not carry it changes
//! nothing else: the QR code still works.

use std::net::Ipv4Addr;

use mdns_sd::{ServiceDaemon, ServiceInfo};

/// The kind of service the iPhone app looks for (its Info.plist names it too).
pub const SERVICE: &str = "_zoodremote._tcp.local.";

pub struct Announcer {
    daemon: ServiceDaemon,
    fullname: String,
}

/// The name as a host name: letters, digits and dashes only.
fn host_label(pc: &str) -> String {
    let label: String = pc
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .take(40)
        .collect();
    let label = label.trim_matches('-');
    if label.is_empty() {
        "zood-pc".into()
    } else {
        label.to_ascii_lowercase()
    }
}

impl Announcer {
    /// Announces the remote at `address`:`port`; `None` when the network
    /// will not have it (logged, nothing else changes).
    pub fn start(pc: &str, address: Ipv4Addr, port: u16) -> Option<Announcer> {
        let daemon = ServiceDaemon::new().ok()?;
        let shown = if pc.is_empty() { "ZOOD PDF" } else { pc };
        let host = format!("{}.local.", host_label(shown));
        let addr = address.to_string();
        let port_text = port.to_string();
        let properties = [
            ("v", "1"),
            ("pc", shown),
            ("addr", addr.as_str()),
            ("port", port_text.as_str()),
        ];
        let info =
            ServiceInfo::new(SERVICE, shown, &host, addr.as_str(), port, &properties[..]).ok()?;
        let fullname = info.get_fullname().to_string();
        if daemon.register(info).is_err() {
            let _ = daemon.shutdown();
            return None;
        }
        Some(Announcer { daemon, fullname })
    }
}

impl Drop for Announcer {
    fn drop(&mut self) {
        let _ = self.daemon.unregister(&self.fullname);
        let _ = self.daemon.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_names_are_plain() {
        assert_eq!(host_label("MOHAMMED-PC"), "mohammed-pc");
        assert_eq!(
            host_label("Mohammed's MacBook Pro"),
            "mohammed-s-macbook-pro"
        );
        assert_eq!(host_label("جهاز"), "zood-pc");
    }

    /// Announced, then found by a browser on the same machine, as the iPhone
    /// app would: the name, address and port in the TXT record. Needs a
    /// network that carries multicast: `cargo test announce -- --ignored`.
    #[test]
    #[ignore]
    fn a_phone_finds_the_pc_by_its_name() {
        let ip = super::super::local_addresses().first().copied().unwrap_or(Ipv4Addr::LOCALHOST);
        let _on = Announcer::start("TEST-PC", ip, 47812).expect("announced");
        let browser = ServiceDaemon::new().unwrap();
        let found = browser.browse(SERVICE).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            if let Ok(mdns_sd::ServiceEvent::ServiceResolved(info)) = found.recv_timeout(std::time::Duration::from_secs(1)) {
                if info.get_property_val_str("pc") == Some("TEST-PC") {
                    assert_eq!(info.get_property_val_str("port"), Some("47812"));
                    assert_eq!(info.get_property_val_str("addr"), Some(ip.to_string().as_str()));
                    return;
                }
            }
        }
        panic!("not found");
    }
}
