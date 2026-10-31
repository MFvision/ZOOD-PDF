//! "Search the internet for…": Ask ZOOD looks something up on the web for
//! the person who asked (`ask/research.ts`). Only the search words and the
//! pages' addresses leave the computer — the reading and the writing are the
//! local model's. A search is DuckDuckGo's plain HTML page; a page is fetched
//! as text: public `http`/`https` addresses only (never this computer or its
//! network), every redirect checked again, a few seconds and a couple of
//! megabytes at most, and only what a person would read kept from it.

use std::net::{IpAddr, ToSocketAddrs};
use std::time::Duration;

use serde::Serialize;
use tauri::Url;

/// Where a search goes: DuckDuckGo's page without scripts.
const SEARCH: &str = "https://html.duckduckgo.com/html/";
/// The most results handed back, and the most redirects followed.
const MOST_HITS: usize = 8;
const REDIRECTS: usize = 5;
/// The most bytes read of a search or a page.
const MOST_BYTES: u64 = 2 * 1024 * 1024;
/// The most letters of a page's text handed to the island.
const MOST_TEXT: usize = 12_000;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct WebHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct WebPage {
    /// Where the page ended up, after its redirects.
    pub url: String,
    pub title: String,
    pub text: String,
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(8)))
        .timeout_global(Some(Duration::from_secs(20)))
        // Followed here, so each hop's address is checked.
        .max_redirects(0)
        .http_status_as_error(false)
        .user_agent("Mozilla/5.0 (compatible; ZOOD-PDF)")
        .build()
        .into()
}

/// The web's results for `query`: titles, addresses and the search's own
/// lines about them.
#[tauri::command(async)]
pub fn ask_web_search(query: String) -> Result<Vec<WebHit>, String> {
    let query: String = query
        .chars()
        .filter(|c| !c.is_control())
        .take(300)
        .collect();
    let query = query.trim();
    if query.is_empty() {
        return Err("E_ARGS: nothing to search for".into());
    }
    let url = Url::parse_with_params(SEARCH, &[("q", query)])
        .map_err(|_| "E_ARGS: a bad search".to_string())?;
    let (_, html) = fetch(url.as_str())?;
    Ok(search_hits(&html))
}

/// A page of the web as the words on it.
#[tauri::command(async)]
pub fn ask_web_read(url: String) -> Result<WebPage, String> {
    let (at, html) = fetch(&url)?;
    let (title, text) = page_text(&html);
    Ok(WebPage {
        url: at,
        title,
        text,
    })
}

/// A GET of a public address, its redirects followed and checked: the
/// address it ended at, and its text.
fn fetch(url: &str) -> Result<(String, String), String> {
    let agent = agent();
    let mut url = url.to_string();
    for _ in 0..=REDIRECTS {
        let parsed = public(&url)?;
        let response = agent
            .get(parsed.as_str())
            .header("Accept", "text/html,text/plain;q=0.9")
            .header("Accept-Language", "ar,en;q=0.8")
            .call()
            .map_err(|e| format!("E_NET: {e}"))?;
        let status = response.status().as_u16();
        if (300..400).contains(&status) {
            let next = response
                .headers()
                .get("location")
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "E_NET: a redirect without a location".to_string())?;
            url = parsed
                .join(next)
                .map_err(|_| format!("E_NET: a bad redirect: {next}"))?
                .to_string();
            continue;
        }
        if status != 200 {
            return Err(format!("E_NET: the site answered {status}"));
        }
        let kind = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("text/html")
            .to_ascii_lowercase();
        if !(kind.starts_with("text/html")
            || kind.starts_with("text/plain")
            || kind.starts_with("application/xhtml"))
        {
            return Err("E_NET: that page is not text".into());
        }
        let bytes = response
            .into_body()
            .with_config()
            .limit(MOST_BYTES)
            .read_to_vec()
            .map_err(|e| format!("E_NET: {e}"))?;
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let text = if kind.starts_with("text/plain") {
            escape_plain(&text)
        } else {
            text
        };
        return Ok((parsed.to_string(), text));
    }
    Err("E_NET: too many redirects".into())
}

/// Plain text read as a page: its `<` and `&` are text.
fn escape_plain(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;")
}

/// `url` when it is an `http`/`https` address of a public host on the usual
/// ports — never this computer, its network or a name that resolves there.
fn public(url: &str) -> Result<Url, String> {
    let parsed = Url::parse(url.trim()).map_err(|_| format!("E_NET: bad address {url}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("E_NET: only web addresses are read".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("E_NET: an address with a password is not read".into());
    }
    if !matches!(parsed.port(), None | Some(80) | Some(443)) {
        return Err("E_NET: only the usual web ports are read".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "E_NET: an address without a host".to_string())?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.eq_ignore_ascii_case("localhost")
        || host.ends_with(".local")
        || !host.contains(['.', ':'])
    {
        return Err("E_NET: addresses on this computer or its network are not read".into());
    }
    let port = parsed.port_or_known_default().unwrap_or(443);
    let addresses: Vec<IpAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("E_NET: {host}: {e}"))?
        .map(|a| a.ip())
        .collect();
    if addresses.is_empty() || addresses.iter().any(|ip| !reachable(ip)) {
        return Err("E_NET: addresses on this computer or its network are not read".into());
    }
    Ok(parsed)
}

/// An address on the internet, not this computer, its network or a reserved one.
pub(crate) fn reachable(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                || a == 0
                || (a == 100 && (64..128).contains(&b))
                || (a == 198 && (b == 18 || b == 19))
                || a >= 240)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return reachable(&IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80)
        }
    }
}

/* ------------------------------------------------------------- reading */

/// The results of DuckDuckGo's HTML page: each `result__a` link (its real
/// address is the `uddg` part of DuckDuckGo's own link), with the
/// `result__snippet` after it. Advertisements are left out.
pub fn search_hits(html: &str) -> Vec<WebHit> {
    let mut hits: Vec<WebHit> = Vec::new();
    let mut rest = html;
    while hits.len() < MOST_HITS {
        let Some(at) = find_class(rest, "result__a").or_else(|| find_class(rest, "result-link"))
        else {
            break;
        };
        let (tag, after) = open_tag(&rest[at..]);
        let inner_end = after.find("</a>").unwrap_or(after.len());
        let title = inline_text(&after[..inner_end]);
        rest = &after[inner_end..];
        let Some(url) = attribute(tag, "href").and_then(|href| real_address(&href)) else {
            continue;
        };
        // The snippet sits before the next result's link.
        let next = find_class(rest, "result__a")
            .or_else(|| find_class(rest, "result-link"))
            .unwrap_or(rest.len());
        let snippet = find_class(&rest[..next], "result__snippet")
            .or_else(|| find_class(&rest[..next], "result-snippet"))
            .map(|s| {
                let (_, body) = open_tag(&rest[s..next]);
                let end = ["</a>", "</td>", "</div>"]
                    .iter()
                    .filter_map(|close| body.find(close))
                    .min()
                    .unwrap_or(body.len());
                inline_text(&body[..end])
            })
            .unwrap_or_default();
        if title.is_empty() || hits.iter().any(|h| h.url == url) {
            continue;
        }
        hits.push(WebHit {
            title,
            url,
            snippet,
        });
    }
    hits
}

/// Where a result's link really goes: DuckDuckGo's `/l/?uddg=` hop read,
/// an advertisement's (`y.js`) dropped, only web addresses kept.
fn real_address(href: &str) -> Option<String> {
    let href = decode_entities(href);
    let full = if href.starts_with("//") {
        format!("https:{href}")
    } else if href.starts_with('/') {
        format!("https://duckduckgo.com{href}")
    } else {
        href
    };
    let url = Url::parse(&full).ok()?;
    let host = url.host_str().unwrap_or("");
    let target = if host.ends_with("duckduckgo.com") {
        if url.path().contains("y.js") {
            return None;
        }
        url.query_pairs()
            .find(|(key, _)| key == "uddg")
            .map(|(_, value)| value.into_owned())?
    } else {
        full
    };
    let target = Url::parse(&target).ok()?;
    (matches!(target.scheme(), "http" | "https") && !target.host_str()?.ends_with("duckduckgo.com"))
        .then(|| target.to_string())
}

/// Where the first tag with `class` among its classes starts.
fn find_class(html: &str, class: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(found) = html[from..].find(class) {
        let at = from + found;
        let before = &html[..at];
        let start = before.rfind('<')?;
        let quoted = before[start..].contains("class=");
        let ends_word = html[at + class.len()..]
            .chars()
            .next()
            .is_some_and(|c| c == '"' || c == '\'' || c == ' ');
        if quoted && ends_word && !before[start..].contains('>') {
            return Some(start);
        }
        from = at + class.len();
    }
    None
}

/// A tag at the start of `html`, and what follows it.
fn open_tag(html: &str) -> (&str, &str) {
    match html.find('>') {
        Some(end) => (&html[..=end], &html[end + 1..]),
        None => (html, ""),
    }
}

/// An attribute's value in one tag.
fn attribute(tag: &str, name: &str) -> Option<String> {
    let mut from = 0;
    while let Some(found) = tag[from..].find(name) {
        let at = from + found;
        let after = tag[at + name.len()..].trim_start();
        let boundary = at == 0 || tag[..at].ends_with([' ', '\t', '\n', '\r']);
        if boundary {
            if let Some(value) = after.strip_prefix('=') {
                let value = value.trim_start();
                let quote = value.chars().next()?;
                if quote == '"' || quote == '\'' {
                    let body = &value[1..];
                    return body.find(quote).map(|end| body[..end].to_string());
                }
                let end = value.find([' ', '>']).unwrap_or(value.len());
                return Some(value[..end].to_string());
            }
        }
        from = at + name.len();
    }
    None
}

/// The words of a bit of HTML on one line: tags dropped, entities read.
fn inline_text(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    decode_entities(&out)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// A page's title and the words a person would read on it: scripts,
/// styles, the head and drawings dropped, block tags made line breaks.
pub fn page_text(html: &str) -> (String, String) {
    let lower = html.to_ascii_lowercase();
    let title = lower
        .find("<title")
        .and_then(|at| {
            let body = &html[at..];
            let start = body.find('>')? + 1;
            let end = body[start..].to_ascii_lowercase().find("</title")?;
            Some(inline_text(&body[start..start + end]))
        })
        .unwrap_or_default();
    const SKIPPED: [&str; 7] = [
        "script", "style", "noscript", "svg", "head", "template", "iframe",
    ];
    const BLOCKS: [&str; 18] = [
        "p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article",
        "header", "footer", "table", "ul", "ol",
    ];
    let mut out = String::new();
    let mut i = 0;
    let bytes = html.as_bytes();
    while i < bytes.len() && out.len() < MOST_TEXT * 4 {
        if bytes[i] == b'<' {
            let Some(close) = html[i..].find('>') else {
                break;
            };
            let tag = &lower[i + 1..i + close];
            if tag.starts_with("!--") {
                let end = lower[i..].find("-->").map_or(bytes.len(), |e| i + e + 3);
                i = end;
                continue;
            }
            let name: String = tag
                .trim_start_matches('/')
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect();
            if !tag.starts_with('/') && SKIPPED.contains(&name.as_str()) && !tag.ends_with('/') {
                let closing = format!("</{name}");
                i = lower[i + close..]
                    .find(&closing)
                    .map_or(bytes.len(), |e| i + close + e);
                continue;
            }
            if BLOCKS.contains(&name.as_str()) {
                out.push('\n');
            } else if (name == "td" || name == "th") && !tag.starts_with('/') {
                out.push_str(" | ");
            } else {
                out.push(' ');
            }
            i += close + 1;
            continue;
        }
        let next = html[i..].find('<').map_or(bytes.len(), |e| i + e);
        out.push_str(&html[i..next]);
        i = next;
    }
    let text = decode_entities(&out);
    let mut lines: Vec<String> = Vec::new();
    for line in text.lines() {
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        let line = line
            .trim_matches(|c: char| c == '|' || c.is_whitespace())
            .to_string();
        if line.chars().count() >= 2 && lines.last() != Some(&line) {
            lines.push(line);
        }
    }
    let mut text = lines.join("\n");
    if text.len() > MOST_TEXT {
        let mut end = MOST_TEXT;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    (title, text)
}

/// `&amp;`, `&#1575;`, `&#x27;`… as the letters they stand for.
fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let end = rest[..rest.len().min(12)].find(';');
        let decoded = end.and_then(|end| {
            let name = &rest[1..end];
            let c = match name {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                "ndash" => Some('–'),
                "mdash" => Some('—'),
                "hellip" => Some('…'),
                "rsquo" | "lsquo" => Some('\''),
                "rdquo" | "ldquo" => Some('"'),
                _ => name
                    .strip_prefix("#x")
                    .or_else(|| name.strip_prefix("#X"))
                    .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                    .or_else(|| name.strip_prefix('#').and_then(|n| n.parse().ok()))
                    .and_then(char::from_u32),
            };
            c.map(|c| (c, end))
        });
        match decoded {
            Some((c, end)) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const RESULTS: &str = r#"
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.com%2Fbest%2Dhubs%3Fa%3D1&amp;rut=abc">Best <b>USB-C</b> hubs &amp; docks</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">The Anker 7-in-1 costs <b>$35</b>&#x27;s worth.</a>
  </div>
</div>
<div class="result result--ad">
  <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=shop.com&amp;u3=x">Buy now</a>
  <a class="result__snippet">An advert</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Far.example.sa%2F%D8%A3%D8%B3%D8%B9%D8%A7%D8%B1">أسعار الموزعات</a>
</div>"#;

    #[test]
    fn search_results_are_read_and_adverts_left_out() {
        let hits = search_hits(RESULTS);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].title, "Best USB-C hubs & docks");
        assert_eq!(hits[0].url, "https://www.example.com/best-hubs?a=1");
        assert_eq!(hits[0].snippet, "The Anker 7-in-1 costs $35's worth.");
        assert_eq!(hits[1].title, "أسعار الموزعات");
        assert!(hits[1].url.starts_with("https://ar.example.sa/"));
        assert_eq!(hits[1].snippet, "");
    }

    #[test]
    fn a_page_is_its_words() {
        let html = "<html><head><title>Hub &amp; dock</title><style>p{}</style></head>\
            <body><script>alert('x')</script><nav>Menu</nav><h1>Anker 7-in-1</h1>\
            <p>Price: <b>$35.99</b></p><!-- hidden --><table><tr><td>Ports</td><td>7</td></tr></table>\
            <noscript>enable js</noscript></body></html>";
        let (title, text) = page_text(html);
        assert_eq!(title, "Hub & dock");
        assert!(text.contains("Anker 7-in-1"));
        assert!(text.contains("Price: $35.99"));
        assert!(text.contains("Ports | 7"));
        assert!(!text.contains("alert"));
        assert!(!text.contains("enable js"));
        assert!(!text.contains("hidden"));
    }

    #[test]
    fn a_long_page_is_cut_on_a_letter() {
        let html = format!("<p>{}</p>", "ب".repeat(MOST_TEXT));
        let (_, text) = page_text(&html);
        assert!(text.len() <= MOST_TEXT);
    }

    #[test]
    fn this_computer_and_its_network_are_never_read() {
        for url in [
            "http://localhost/",
            "http://127.0.0.1/",
            "http://192.168.1.1/admin",
            "http://10.0.0.5/",
            "http://[::1]/",
            "http://169.254.169.254/latest/meta-data",
            "file:///etc/passwd",
            "https://example.com:8443/",
            "https://user:pass@example.com/",
            "http://router/",
            "http://printer.local/",
        ] {
            assert!(public(url).is_err(), "{url} should be refused");
        }
    }

    #[test]
    fn public_addresses_are_told_from_private_ones() {
        assert!(reachable(&"93.184.216.34".parse().unwrap()));
        assert!(reachable(&"2606:4700::1111".parse().unwrap()));
        for ip in [
            "100.64.0.1",
            "172.16.0.1",
            "0.0.0.0",
            "::ffff:127.0.0.1",
            "fd00::1",
            "fe80::1",
        ] {
            assert!(!reachable(&ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn entities_are_read() {
        assert_eq!(
            decode_entities("a &amp; b &#1575; &#x41; &bogus; &"),
            "a & b ا A &bogus; &"
        );
    }
}
