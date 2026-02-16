//! DID Document ↔ DNS TXT record encoding for did:dht.
//!
//! The did:dht spec encodes DID documents as DNS TXT records:
//! - `_did.<id>` root record: `id=<did>;t=<type>`
//! - `_k<N>._did` verification keys: `id=<vm-id>;t=0;k=<base64url-pub-key>`

use simple_dns::rdata::RData;
use simple_dns::{Name, Packet, ResourceRecord, CLASS, TYPE};

use std::collections::HashMap;

/// Build a DNS packet encoding a minimal DID document with a single Ed25519 key.
pub fn encode_did_document(did: &str, public_key_base64url: &str) -> Vec<u8> {
    let mut packet = Packet::new_reply(0);

    // Root TXT record: _did.<id>
    let root_name = Name::new_unchecked("_did");
    let root_txt = format!("id={did};t=0");
    let root_rdata = RData::TXT(simple_dns::rdata::TXT::new().with_string(&root_txt).unwrap());
    let root_rr = ResourceRecord::new(root_name, CLASS::IN, 7200, root_rdata);
    packet.answers.push(root_rr);

    // Key TXT record: _k0._did
    let key_name = Name::new_unchecked("_k0._did");
    let key_txt = format!("id=0;t=0;k={public_key_base64url}");
    let key_rdata = RData::TXT(simple_dns::rdata::TXT::new().with_string(&key_txt).unwrap());
    let key_rr = ResourceRecord::new(key_name, CLASS::IN, 7200, key_rdata);
    packet.answers.push(key_rr);

    packet.build_bytes_vec().unwrap()
}

/// Decode a DNS packet back into DID document components.
/// Returns a map of record names to their TXT values.
pub fn decode_did_document(dns_bytes: &[u8]) -> HashMap<String, String> {
    let mut result = HashMap::new();

    if let Ok(packet) = Packet::parse(dns_bytes) {
        for answer in &packet.answers {
            if answer.rdatatype == TYPE::TXT {
                let name = answer.name.to_string();
                if let RData::TXT(txt) = answer.rdata.clone() {
                    // Collect all character strings from the TXT record
                    let value: String = txt
                        .attributes()
                        .iter()
                        .map(|(k, v)| {
                            if let Some(val) = v {
                                format!("{k}={val}")
                            } else {
                                k.to_string()
                            }
                        })
                        .collect::<Vec<_>>()
                        .join(";");
                    result.insert(name, value);
                }
            }
        }
    }

    result
}
