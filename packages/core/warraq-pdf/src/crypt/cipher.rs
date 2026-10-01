//! The ciphers used by the standard security handler (ISO 32000-2 §7.6.3):
//! RC4, AES-128-CBC (`/AESV2`) and AES-256-CBC (`/AESV3`).
//!
//! Everything here is RustCrypto (`aes` + `cbc`) except RC4, which is short
//! enough that writing it out costs less than another dependency. No `unsafe`.

use aes::cipher::{BlockModeDecrypt as _, BlockModeEncrypt as _, KeyIvInit as _};

use super::CryptError;

type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;
type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;
type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;
type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;

/// An AES block is 16 bytes whatever the key size, so one helper serves both.
fn block(bytes: &mut [u8]) -> &mut aes::cipher::Block<aes::Aes128> {
    bytes.try_into().expect("AES blocks are 16 bytes")
}

/// RC4 (ARC4) as used by `/V 1`, `/V 2` and the `/V2` crypt filter.
///
/// RC4 is its own inverse, so this is both the encryption and the decryption
/// routine. An empty key cannot key the cipher; the input is then returned
/// unchanged, which is what callers want for an `/Identity`-like no-op.
pub fn rc4(key: &[u8], data: &[u8]) -> Vec<u8> {
    if key.is_empty() {
        return data.to_vec();
    }
    let mut s: [u8; 256] = core::array::from_fn(|i| i as u8);
    let mut j = 0u8;
    for i in 0..256 {
        j = j.wrapping_add(s[i]).wrapping_add(key[i % key.len()]);
        s.swap(i, j as usize);
    }
    let (mut i, mut j) = (0u8, 0u8);
    data.iter()
        .map(|byte| {
            i = i.wrapping_add(1);
            j = j.wrapping_add(s[i as usize]);
            s.swap(i as usize, j as usize);
            let k = s[i as usize].wrapping_add(s[j as usize]);
            byte ^ s[k as usize]
        })
        .collect()
}

/// Strip the padding that ISO 32000-2 §7.6.3.2 prescribes for AES strings and
/// streams (RFC 2898 / PKCS#7 over a 16-byte block).
///
/// Malformed padding is tolerated rather than rejected: a handful of producers
/// write the plaintext length short of a full pad, and refusing to open such a
/// file would be worse than handing back a few trailing bytes.
fn strip_padding(mut data: Vec<u8>) -> Vec<u8> {
    let Some(&pad) = data.last() else {
        return data;
    };
    if (1..=16).contains(&pad) && (pad as usize) <= data.len() {
        let keep = data.len() - pad as usize;
        if data[keep..].iter().all(|b| *b == pad) {
            data.truncate(keep);
        }
    }
    data
}

/// Decrypt an AES-CBC string or stream: the first 16 bytes are the
/// initialisation vector, the rest is CBC ciphertext with PKCS#7 padding.
///
/// `key` must be 16 bytes (`/AESV2`) or 32 bytes (`/AESV3`). Data that is
/// empty, or that holds nothing but an IV, decrypts to nothing — an encrypted
/// zero-length stream is written exactly like that.
pub fn aes_cbc_decrypt(key: &[u8], data: &[u8]) -> Result<Vec<u8>, CryptError> {
    if data.len() <= 16 {
        return Ok(Vec::new());
    }
    let (iv, body) = data.split_at(16);
    let iv: &[u8; 16] = iv.try_into().expect("split at 16");
    // Trailing bytes that do not fill a block cannot be decrypted; dropping
    // them is what every other reader does with such a truncated stream.
    let usable = body.len() - body.len() % 16;
    let mut out = body[..usable].to_vec();

    match key.len() {
        16 => {
            let key: &[u8; 16] = key.try_into().expect("length checked");
            let mut dec = Aes128CbcDec::new(key.into(), iv.into());
            for chunk in out.as_chunks_mut::<16>().0 {
                dec.decrypt_block(block(chunk));
            }
        }
        32 => {
            let key: &[u8; 32] = key.try_into().expect("length checked");
            let mut dec = Aes256CbcDec::new(key.into(), iv.into());
            for chunk in out.as_chunks_mut::<16>().0 {
                dec.decrypt_block(block(chunk));
            }
        }
        n => return Err(CryptError::Unsupported(format!("AES key of {n} bytes"))),
    }
    Ok(strip_padding(out))
}

/// Encrypt a string or stream for writing with AES-CBC: PKCS#7 padding, and
/// the initialisation vector in front of the ciphertext, which is how
/// [`aes_cbc_decrypt`] and every other reader expect it (ISO 32000-2 §7.6.3).
///
/// `key` must be 16 bytes (`/AESV2`) or 32 bytes (`/AESV3`); `iv` must be
/// fresh and unpredictable for each string or stream.
pub fn aes_cbc_encrypt(key: &[u8], iv: &[u8; 16], data: &[u8]) -> Result<Vec<u8>, CryptError> {
    let pad = 16 - data.len() % 16;
    let mut body = data.to_vec();
    body.extend(std::iter::repeat_n(pad as u8, pad));
    match key.len() {
        16 => {
            let key: &[u8; 16] = key.try_into().expect("length checked");
            let mut enc = Aes128CbcEnc::new(key.into(), iv.into());
            for chunk in body.as_chunks_mut::<16>().0 {
                enc.encrypt_block(block(chunk));
            }
        }
        32 => {
            let key: &[u8; 32] = key.try_into().expect("length checked");
            let mut enc = Aes256CbcEnc::new(key.into(), iv.into());
            for chunk in body.as_chunks_mut::<16>().0 {
                enc.encrypt_block(block(chunk));
            }
        }
        n => return Err(CryptError::Unsupported(format!("AES key of {n} bytes"))),
    }
    let mut out = Vec::with_capacity(16 + body.len());
    out.extend_from_slice(iv);
    out.extend_from_slice(&body);
    Ok(out)
}

/// AES-256-CBC with a zero IV and no padding, used by algorithm 2.A to unwrap
/// the file encryption key from `/UE` or `/OE`.
pub fn aes256_cbc_decrypt_no_padding(key: &[u8; 32], data: &[u8]) -> Vec<u8> {
    let iv = [0u8; 16];
    let usable = data.len() - data.len() % 16;
    let mut out = data[..usable].to_vec();
    let mut dec = Aes256CbcDec::new(key.into(), (&iv).into());
    for chunk in out.as_chunks_mut::<16>().0 {
        dec.decrypt_block(block(chunk));
    }
    out
}

/// AES-256-CBC encryption with a zero IV and no padding: the inverse of
/// [`aes256_cbc_decrypt_no_padding`], used by algorithms 8 and 9 to wrap the
/// file encryption key into `/UE` and `/OE`. `data` is the 32-byte file key,
/// so nothing needs padding.
pub fn aes256_cbc_encrypt_no_padding(key: &[u8; 32], data: &[u8]) -> Vec<u8> {
    let iv = [0u8; 16];
    let usable = data.len() - data.len() % 16;
    let mut out = data[..usable].to_vec();
    let mut enc = Aes256CbcEnc::new(key.into(), (&iv).into());
    for chunk in out.as_chunks_mut::<16>().0 {
        enc.encrypt_block(block(chunk));
    }
    out
}

/// AES-256-ECB encryption of one 16-byte block, which is the single place the
/// PDF standard security handler needs ECB: algorithm 10 encrypts the 16-byte
/// `/Perms` value with the file key and no initialisation vector at all.
pub fn aes256_ecb_encrypt_block(key: &[u8; 32], data: &mut [u8; 16]) {
    use aes::cipher::{BlockCipherEncrypt as _, KeyInit as _};
    let cipher = aes::Aes256::new(key.into());
    cipher.encrypt_block(block(data));
}

/// AES-256-ECB decryption of one 16-byte block, which reads `/Perms` back.
/// Only the tests need it: the reader takes the permissions from `/P`, as
/// every other reader does, and `/Perms` exists here to be written correctly.
#[cfg(test)]
pub fn aes256_ecb_decrypt_block(key: &[u8; 32], data: &mut [u8; 16]) {
    use aes::cipher::{BlockCipherDecrypt as _, KeyInit as _};
    let cipher = aes::Aes256::new(key.into());
    cipher.decrypt_block(block(data));
}

/// AES-128-CBC encryption in place with no padding, used by the hardened hash
/// of algorithm 2.B. `data` is always a multiple of 16 bytes there (64
/// repetitions of a block-aligned string), so nothing needs padding.
pub fn aes128_cbc_encrypt_in_place(key: &[u8; 16], iv: &[u8; 16], data: &mut [u8]) {
    let mut enc = Aes128CbcEnc::new(key.into(), iv.into());
    for chunk in data.as_chunks_mut::<16>().0 {
        enc.encrypt_block(block(chunk));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The test vectors of RFC 6229 §2 (RC4 with a 40-bit and a 128-bit key).
    #[test]
    fn rc4_matches_rfc_6229() {
        let out = rc4(&[0x01, 0x02, 0x03, 0x04, 0x05], &[0u8; 16]);
        assert_eq!(
            out,
            [
                0xb2, 0x39, 0x63, 0x05, 0xf0, 0x3d, 0xc0, 0x27, 0xcc, 0xc3, 0x52, 0x4a, 0x0a, 0x11,
                0x18, 0xa8
            ]
        );
        let key: Vec<u8> = (1..=16).collect();
        let out = rc4(&key, &[0u8; 16]);
        assert_eq!(
            out,
            [
                0x9a, 0xc7, 0xcc, 0x9a, 0x60, 0x9d, 0x1e, 0xf7, 0xb2, 0x93, 0x28, 0x99, 0xcd, 0xe4,
                0x1b, 0x97
            ]
        );
        // RC4 is an involution: encrypting the ciphertext gives the plaintext.
        assert_eq!(rc4(&key, &out), [0u8; 16]);
    }

    /// NIST SP 800-38A F.2.2/F.2.6: AES-CBC with the standard example key and
    /// IV. The PDF framing (IV first, PKCS#7 last) is added by hand here.
    #[test]
    fn aes_cbc_decrypts_nist_vectors() {
        let key128 = hex("2b7e151628aed2a6abf7158809cf4f3c");
        let iv = hex("000102030405060708090a0b0c0d0e0f");
        let plain = hex("6bc1bee22e409f96e93d7e117393172a");
        let cipher = hex("7649abac8119b246cee98e9b12e9197d");
        let mut framed = iv.clone();
        framed.extend_from_slice(&cipher);
        // No padding block follows, so strip_padding must leave the block alone
        // (its last byte, 0x2a, is not a valid pad length).
        assert_eq!(aes_cbc_decrypt(&key128, &framed).unwrap(), plain);

        let key256 = hex("603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4");
        let cipher = hex("f58c4c04d6e5f1ba779eabfb5f7bfbd6");
        let mut framed = iv.clone();
        framed.extend_from_slice(&cipher);
        assert_eq!(aes_cbc_decrypt(&key256, &framed).unwrap(), plain);

        // An encrypted empty stream is just an IV (or nothing at all).
        assert!(aes_cbc_decrypt(&key128, &iv).unwrap().is_empty());
        assert!(aes_cbc_decrypt(&key128, &[]).unwrap().is_empty());
        assert!(matches!(
            aes_cbc_decrypt(&[0u8; 24], &framed),
            Err(CryptError::Unsupported(_))
        ));
    }

    #[test]
    fn aes128_cbc_encryption_round_trips_through_the_decryptor() {
        let key = [0x11u8; 16];
        let iv = [0x22u8; 16];
        let mut data = [0x33u8; 64];
        aes128_cbc_encrypt_in_place(&key, &iv, &mut data);
        let mut framed = iv.to_vec();
        framed.extend_from_slice(&data);
        // No PKCS#7 block was appended, so the plaintext comes back whole.
        assert_eq!(aes_cbc_decrypt(&key, &framed).unwrap(), [0x33u8; 64]);
    }

    #[test]
    fn padding_is_stripped_only_when_it_is_well_formed() {
        assert_eq!(strip_padding(vec![1, 2, 3, 4, 4, 4, 4]), vec![1, 2, 3]);
        assert_eq!(strip_padding(vec![16u8; 16]), Vec::<u8>::new());
        assert_eq!(strip_padding(vec![1, 2, 4, 4]), vec![1, 2, 4, 4]);
        assert_eq!(strip_padding(vec![1, 2, 200]), vec![1, 2, 200]);
    }

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len() / 2)
            .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap())
            .collect()
    }
}
