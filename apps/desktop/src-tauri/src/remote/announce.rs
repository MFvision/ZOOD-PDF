//! The remote says where it is on the local network (Bonjour / mDNS), so the
//! ZOOD iPhone app finds this PC again by its name when its address changes,
//! without a new QR code. Only while the remote is on.
//!
//! It tells what a phone on the same Wi-Fi could find by trying (the PC's
//! name, its address and the remote's port) and, for each paired phone, an
//! 8-byte tag only that phone's key makes for this address
//! (`seal::here_tag`), so the app can tell the real PC from a device that
//! merely uses its name. No key goes out: a phone still needs the pairing it
//! got from a QR code to be let in.
//!
//! mdns-sd (Apache-2.0 OR MIT). A network that will not carry it changes
//! nothing else: the QR code still works.

use std::net::Ipv4Addr;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use mdns_sd::{ServiceDaemon, ServiceInfo};

use super::seal::{here_tag, SealKey};

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

/// The tags of up to eight phones, one after the other, in URL-safe base64.
pub fn tags(keys: &[SealKey], address: &str) -> String {
    let joined: Vec<u8> = keys
        .iter()
        .take(8)
        .flat_map(|key| here_tag(key, address))
        .collect();
    URL_SAFE_NO_PAD.encode(joined)
}

impl Announcer {
    /// Announces the remote at `address`:`port`, with a tag for each of
    /// `keys` (the paired phones'); `None` when the network will not have it
    /// (logged, nothing else changes).
    pub fn start(pc: &str, address: Ipv4Addr, port: u16, keys: &[SealKey]) -> Option<Announcer> {
        let daemon = ServiceDaemon::new().ok()?;
        let shown = if pc.is_empty() { "ZOOD PDF" } else { pc };
        let host = format!("{}.local.", host_label(shown));
        let addr = address.to_string();
        let port_text = port.to_string();
        let seen = tags(keys, &format!("{addr}:{port}"));
        let properties = [
            ("v", "1"),
            ("pc", shown),
            ("addr", addr.as_str()),
            ("port", port_text.as_str()),
            ("seen", seen.as_str()),
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

    /// The iPhone app (`RemoteFinder.swift`) makes the same tags: pinned.
    #[test]
    fn tags_are_pinned() {
        let one = tags(&[[1u8; 32]], "192.168.1.20:47800");
        assert_eq!(one.len(), 11);
        assert_eq!(
            tags(&[[1u8; 32], [2u8; 32]], "192.168.1.20:47800").len(),
            22
        );
        let two = URL_SAFE_NO_PAD
            .decode(tags(&[[1u8; 32], [2u8; 32]], "192.168.1.20:47800"))
            .unwrap();
        assert_eq!(&two[..8], &URL_SAFE_NO_PAD.decode(&one).unwrap()[..]);
        assert_ne!(one, tags(&[[1u8; 32]], "192.168.1.21:47800"));
        assert_eq!(tags(&[], "x"), "");
        assert_eq!(one, "4Puanl3SBJY");
    }

    /// Announced, then found by a browser on the same machine, as the iPhone
    /// app would: the name, address and port in the TXT record. Needs a
    /// network that carries multicast: `cargo test announce -- --ignored`.
    #[test]
    #[ignore]
    fn a_phone_finds_the_pc_by_its_name() {
        let ip = super::super::local_addresses()
            .first()
            .copied()
            .unwrap_or(Ipv4Addr::LOCALHOST);
        let _on = Announcer::start("TEST-PC", ip, 47812, &[[7u8; 32]]).expect("announced");
        let browser = ServiceDaemon::new().unwrap();
        let found = browser.browse(SERVICE).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            if let Ok(mdns_sd::ServiceEvent::ServiceResolved(info)) =
                found.recv_timeout(std::time::Duration::from_secs(1))
            {
                if info.get_property_val_str("pc") == Some("TEST-PC") {
                    assert_eq!(info.get_property_val_str("port"), Some("47812"));
                    assert_eq!(
                        info.get_property_val_str("addr"),
                        Some(ip.to_string().as_str())
                    );
                    assert_eq!(
                        info.get_property_val_str("seen"),
                        Some(tags(&[[7u8; 32]], &format!("{ip}:47812")).as_str())
                    );
                    return;
                }
            }
        }
        panic!("not found");
    }
}
