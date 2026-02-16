//! Core did:dht logic wrapping the `pkarr` crate.
//!
//! Provides creation, derivation, publishing, and resolution of did:dht identifiers.

use ed25519_dalek::SigningKey;
use pkarr::mainline::Testnet;
use pkarr::{Client, Keypair, SignedPacket};

use crate::dns_encoding::encode_did_document;

/// Create a new did:dht identity (fresh keypair).
/// Returns `(did_string, private_key_bytes, public_key_bytes)`.
pub fn create() -> (String, Vec<u8>, Vec<u8>) {
    let keypair = Keypair::random();
    let public_key = keypair.public_key();
    let did = format!("did:dht:{}", public_key.to_z32());

    let secret = keypair.secret_key().to_bytes().to_vec();
    let pubkey = public_key.to_bytes().to_vec();

    (did, secret, pubkey)
}

/// Derive a did:dht from an existing Ed25519 seed (32 bytes).
/// This allows the Python identity's keypair to also produce a did:dht.
pub fn from_private_key(seed_bytes: &[u8]) -> Result<String, String> {
    if seed_bytes.len() != 32 {
        return Err("Ed25519 seed must be exactly 32 bytes".into());
    }

    let seed: [u8; 32] = seed_bytes.try_into().unwrap();
    let signing_key = SigningKey::from_bytes(&seed);
    let verifying_key = signing_key.verifying_key();

    // pkarr uses z-base-32 encoding of the public key
    let z32 = zbase32::encode_full_bytes(verifying_key.as_bytes());
    Ok(format!("did:dht:{z32}"))
}

/// Publish a DID document to the DHT network.
///
/// # Arguments
/// * `seed_bytes` — 32-byte Ed25519 private key seed
/// * `public_key_base64url` — base64url-encoded public key for DNS TXT record
/// * `use_testnet` — if true, publish to pkarr testnet instead of mainline
pub fn publish(
    seed_bytes: &[u8],
    public_key_base64url: &str,
    use_testnet: bool,
) -> Result<String, String> {
    if seed_bytes.len() != 32 {
        return Err("Ed25519 seed must be exactly 32 bytes".into());
    }

    let seed: [u8; 32] = seed_bytes.try_into().unwrap();
    let keypair = Keypair::from_secret_key(&seed);
    let did = format!("did:dht:{}", keypair.public_key().to_z32());

    let dns_bytes = encode_did_document(&did, public_key_base64url);

    let signed_packet = SignedPacket::from_packet(&keypair, &dns_bytes)
        .map_err(|e| format!("Failed to sign DNS packet: {e}"))?;

    let rt = tokio::runtime::Runtime::new().map_err(|e| format!("Tokio runtime error: {e}"))?;

    rt.block_on(async {
        let client = if use_testnet {
            Client::builder().testnet(&Testnet::new(10)).build()
        } else {
            Client::builder().build()
        };

        client
            .publish(&signed_packet, None)
            .await
            .map_err(|e| format!("Failed to publish to DHT: {e}"))?;

        Ok(did)
    })
}

/// Resolve a did:dht identifier from the DHT network.
/// Returns the raw DNS TXT record data as a JSON-compatible map.
pub fn resolve(did: &str, use_testnet: bool) -> Result<String, String> {
    let z32_id = did
        .strip_prefix("did:dht:")
        .ok_or_else(|| "Invalid did:dht format".to_string())?;

    let public_key =
        pkarr::PublicKey::try_from(z32_id).map_err(|e| format!("Invalid z-base-32 key: {e}"))?;

    let rt = tokio::runtime::Runtime::new().map_err(|e| format!("Tokio runtime error: {e}"))?;

    rt.block_on(async {
        let client = if use_testnet {
            Client::builder().testnet(&Testnet::new(10)).build()
        } else {
            Client::builder().build()
        };

        let signed_packet = client
            .resolve(&public_key, None)
            .await
            .map_err(|e| format!("DHT resolve error: {e}"))?
            .ok_or_else(|| "DID not found on DHT".to_string())?;

        let dns_records = crate::dns_encoding::decode_did_document(signed_packet.as_bytes());
        serde_json::to_string(&dns_records).map_err(|e| format!("JSON error: {e}"))
    })
}
