//! PyO3 bindings for did:dht — exposes Rust pkarr functionality to Python.

mod did_dht;
mod dns_encoding;

use pyo3::prelude::*;

/// Create a new did:dht identity with a fresh keypair.
/// Returns `(did_string, private_key_bytes, public_key_bytes)`.
#[pyfunction]
fn create_did_dht() -> PyResult<(String, Vec<u8>, Vec<u8>)> {
    Ok(did_dht::create())
}

/// Derive a did:dht identifier from an existing Ed25519 private key seed (32 bytes).
#[pyfunction]
fn did_dht_from_private_key(seed_bytes: Vec<u8>) -> PyResult<String> {
    did_dht::from_private_key(&seed_bytes).map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(e))
}

/// Publish a DID document to the DHT network.
///
/// Args:
///     seed_bytes: 32-byte Ed25519 private key seed
///     public_key_base64url: base64url-encoded public key for the DID document
///     use_testnet: if True, publish to pkarr testnet instead of mainline DHT
///
/// Returns the did:dht string on success.
#[pyfunction]
#[pyo3(signature = (seed_bytes, public_key_base64url, use_testnet = false))]
fn publish_did_dht(
    seed_bytes: Vec<u8>,
    public_key_base64url: String,
    use_testnet: bool,
) -> PyResult<String> {
    did_dht::publish(&seed_bytes, &public_key_base64url, use_testnet)
        .map_err(|e| PyErr::new::<pyo3::exceptions::PyRuntimeError, _>(e))
}

/// Resolve a did:dht identifier from the DHT network.
/// Returns the DID document DNS records as a JSON string.
#[pyfunction]
#[pyo3(signature = (did, use_testnet = false))]
fn resolve_did_dht(did: String, use_testnet: bool) -> PyResult<String> {
    did_dht::resolve(&did, use_testnet)
        .map_err(|e| PyErr::new::<pyo3::exceptions::PyRuntimeError, _>(e))
}

/// Python module for did:dht operations.
#[pymodule]
fn dina_dht(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(create_did_dht, m)?)?;
    m.add_function(wrap_pyfunction!(did_dht_from_private_key, m)?)?;
    m.add_function(wrap_pyfunction!(publish_did_dht, m)?)?;
    m.add_function(wrap_pyfunction!(resolve_did_dht, m)?)?;
    Ok(())
}
