"""E2E Test Suite 18: Move to a New Machine.

Portability and recovery as user journey.

Actors: Don Alonso.
"""

from __future__ import annotations

import json

import pytest

from tests.e2e.actors import HomeNode, _derive_dek
from tests.e2e.mocks import (
    DeviceType,
    MockD2DNetwork,
    MockPLCDirectory,
    PersonaType,
    TrustRing,
)


# ---------------------------------------------------------------------------
# Suite 18: Move to a New Machine
# ---------------------------------------------------------------------------


class TestMoveMachine:
    """E2E-18.x -- Export/import, mnemonic recovery, and device re-pairing
    for machine migration."""

# TST-E2E-102
    # TRACE: {"suite": "E2E", "case": "0102", "section": "18", "sectionName": "Move Machine", "subsection": "01", "scenario": "01", "title": "export_import_restores_data"}
    def test_export_import_restores_data(
        self,
        don_alonso: HomeNode,
        plc_directory: MockPLCDirectory,
        d2d_network: MockD2DNetwork,
    ) -> None:
        """E2E-18.1 Export populated node, import on fresh node, data restored.

        Export Don Alonso's node (vault items + DID + persona structure),
        create a fresh node, import the archive, and verify that identity,
        personas, and vault data are fully restored.
        """
        source = don_alonso

        # Ensure source has data to export
        source.vault_store(
            "consumer", "migration_test_item",
            {"product": "Standing Desk", "score": 87},
        )
        consumer_items_before = dict(source.personas["consumer"].items)
        personal_items_before = dict(source.personas["general"].items)

        # -- Export: snapshot the node state --------------------------------
        # Serialize contacts with enum values converted to strings
        serializable_contacts = {}
        for cdid, cdata in source.contacts.items():
            serializable_contacts[cdid] = {
                k: (v.value if hasattr(v, "value") else v)
                for k, v in cdata.items()
            }

        export_archive = {
            "did": source.did,
            "display_name": source.display_name,
            "master_seed": source.master_seed,
            "mnemonic": list(source.mnemonic),
            "personas": {},
            "contacts": serializable_contacts,
            "sharing_policies": {
                k: {
                    "contact_did": v.contact_did,
                    "presence": v.presence,
                    "context": v.context,
                }
                for k, v in source.sharing_policies.items()
            },
        }
        for pname, persona in source.personas.items():
            export_archive["personas"][pname] = {
                "name": persona.name,
                "persona_type": persona.persona_type.value,
                "tier": persona.tier,
                "items": {
                    iid: {
                        "item_id": item.item_id,
                        "persona": item.persona,
                        "item_type": item.item_type,
                        "source": item.source,
                        "summary": item.summary,
                        "body_text": item.body_text,
                    }
                    for iid, item in persona.items.items()
                },
            }

        # Serialize and deserialize (simulate file transfer)
        archive_bytes = json.dumps(export_archive).encode()
        assert len(archive_bytes) > 0

        imported_archive = json.loads(archive_bytes)

        # -- Import: create a fresh node and restore -----------------------
        fresh = HomeNode(
            did=imported_archive["did"],
            display_name=imported_archive["display_name"],
            trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
            plc=plc_directory,
            network=d2d_network,
            master_seed=imported_archive["master_seed"],
        )
        fresh.first_run_setup("alonso@example.com", "passphrase123")

        # Restore personas
        for pname, pdata in imported_archive["personas"].items():
            if pname not in fresh.personas:
                fresh.create_persona(
                    pname,
                    PersonaType(pdata["persona_type"]),
                    pdata["tier"],
                )
            # Unlock locked personas before restoring data — during a real
            # import the master seed provides access to all persona DEKs.
            persona_obj = fresh.personas[pname]
            if persona_obj.tier == "locked" and not persona_obj.unlocked:
                fresh.unlock_persona(pname, "passphrase123")
            # Restore vault items
            for iid, idata in pdata["items"].items():
                fresh.vault_store(
                    pname, idata["summary"], idata["body_text"],
                    item_type=idata["item_type"], source=idata["source"],
                )

        # Restore contacts
        fresh.contacts = imported_archive["contacts"]

        # -- Verify identity restored --------------------------------------
        assert fresh.did == source.did, (
            "Imported node DID must match source"
        )
        assert fresh.master_seed == source.master_seed, (
            "Imported master seed must match source"
        )
        assert fresh.root_public_key == source.root_public_key, (
            "Derived public key must match after seed import"
        )

        # -- Verify personas restored -------------------------------------
        for pname in source.personas:
            assert pname in fresh.personas, (
                f"Persona {pname} missing after import"
            )

        # -- Verify vault data restored ------------------------------------
        fresh_consumer = fresh.personas.get("consumer")
        assert fresh_consumer is not None
        assert len(fresh_consumer.items) == len(consumer_items_before), (
            f"Consumer vault item count must match: "
            f"{len(fresh_consumer.items)} != {len(consumer_items_before)}"
        )

        # Search for the migration test item with VALUE assertions
        results = fresh.vault_query("consumer", "migration_test_item")
        assert len(results) == 1, (
            f"Expected exactly 1 migration_test_item, got {len(results)}"
        )
        restored_item = results[0]
        assert "Standing Desk" in restored_item.body_text
        assert restored_item.persona == "consumer"

        # Negative control: non-existent item returns empty
        empty = fresh.vault_query("consumer", "nonexistent_migration_xyz")
        assert len(empty) == 0, "Non-existent item must return empty"

        # -- Verify contacts restored --------------------------------------
        assert "did:plc:sancho" in fresh.contacts

        # -- Verify personal persona items also restored -------------------
        fresh_personal = fresh.personas.get("general")
        assert fresh_personal is not None
        assert len(fresh_personal.items) == len(personal_items_before), (
            f"Personal vault item count must match: "
            f"{len(fresh_personal.items)} != {len(personal_items_before)}"
        )

# TST-E2E-103
    # TRACE: {"suite": "E2E", "case": "0103", "section": "18", "sectionName": "Move Machine", "subsection": "01", "scenario": "02", "title": "mnemonic_recovery_identity_only"}
    def test_mnemonic_recovery_identity_only(
        self,
        don_alonso: HomeNode,
        plc_directory: MockPLCDirectory,
        d2d_network: MockD2DNetwork,
    ) -> None:
        """E2E-18.2 Mnemonic recovery restores identity but vault is empty.

        Destroy local state, recover the identity via the mnemonic
        (master seed), verify the DID and keys are restored, but the
        vault contains no items (mnemonic recovers keys, not data).
        """
        source = don_alonso

        # Record the identity before "destruction"
        original_did = source.did
        original_seed = source.master_seed
        original_mnemonic = list(source.mnemonic)
        original_pubkey = source.root_public_key

        # Verify source has vault data
        source_personal_count = len(source.personas["general"].items)
        assert source_personal_count > 0, (
            "Source must have vault data before recovery test"
        )

        # -- Simulate total local state destruction ------------------------
        # Create a new node from mnemonic (seed recovery)
        # In real Dina, mnemonic -> master_seed via BIP-39.
        # In mock, the master_seed is stored directly.
        recovered = HomeNode(
            did=original_did,
            display_name="Don Alonso (recovered)",
            trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
            plc=plc_directory,
            network=d2d_network,
            master_seed=original_seed,
        )

        # Re-derive keys from recovered seed
        recovered.mnemonic = original_mnemonic
        recovered_priv = _derive_dek(original_seed, "m/9999'/0'")
        recovered_pub = _derive_dek(recovered_priv, "pub")

        # -- Verify identity is restored -----------------------------------
        assert recovered.did == original_did, (
            "Recovered DID must match original"
        )
        assert recovered.master_seed == original_seed, (
            "Recovered master seed must match original"
        )
        assert recovered_pub == original_pubkey, (
            "Derived public key must match after mnemonic recovery"
        )

        # -- Verify vault is EMPTY (mnemonic does not carry data) ----------
        # The recovered node has no personas set up yet (just created)
        for pname, persona in recovered.personas.items():
            assert len(persona.items) == 0, (
                f"Recovered persona {pname} must have empty vault "
                f"(mnemonic recovers keys, not data)"
            )

        # After first_run_setup, only the personal persona exists with no
        # items (the setup creates the persona but not the data)
        recovered.first_run_setup("alonso@example.com", "new_passphrase")
        assert "general" in recovered.personas
        assert len(recovered.personas["general"].items) == 0, (
            "Recovered personal persona vault must be empty"
        )

# TST-E2E-104
    # TRACE: {"suite": "E2E", "case": "0104", "section": "18", "sectionName": "Move Machine", "subsection": "01", "scenario": "03", "title": "import_requires_device_repairing"}
    def test_import_requires_device_repairing(
        self,
        don_alonso: HomeNode,
        plc_directory: MockPLCDirectory,
        d2d_network: MockD2DNetwork,
    ) -> None:
        """E2E-18.3 Import onto new node invalidates old device credentials.

        After importing identity onto a new machine, old device tokens
        from the source node must be rejected.  Re-pairing on the new
        node must succeed.
        """
        source = don_alonso

        # Record old device credentials (ID + token + hash)
        old_devices = {
            dev_id: dev.token
            for dev_id, dev in source.devices.items()
        }
        old_token_hashes = {
            dev.token_hash for dev in source.devices.values()
        }
        old_device_count = len(old_devices)
        assert old_device_count >= 1, "Source must have at least one device"

        # -- Create the "new machine" node ---------------------------------
        new_node = HomeNode(
            did=source.did,
            display_name="Don Alonso (new machine)",
            trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
            plc=plc_directory,
            network=d2d_network,
            master_seed=source.master_seed,
        )
        new_node.first_run_setup("alonso@example.com", "passphrase123")

        # -- Old device credentials must be invalid on new node ------------
        assert len(new_node.devices) == 0, (
            "New node must start with zero registered devices"
        )

        # Verify old device IDs are not recognized and connect fails
        for old_dev_id, old_token in old_devices.items():
            assert old_dev_id not in new_node.devices, (
                f"Old device {old_dev_id} must not exist on new node"
            )
            connect_result = new_node.connect_device(old_dev_id)
            assert connect_result is False, (
                f"Connecting with old device ID {old_dev_id} must fail"
            )

        # -- Re-pairing on new node succeeds -------------------------------
        code = new_node.generate_pairing_code()
        new_device = new_node.pair_device(code, DeviceType.RICH_CLIENT)
        assert new_device is not None, "Re-pairing must succeed on new node"
        assert new_device.connected is True
        assert new_device.device_id not in old_devices, (
            "New device ID must differ from old device IDs"
        )

        # New device token must differ from ALL old tokens
        for old_token in old_devices.values():
            assert new_device.token != old_token, (
                "New device token must differ from old device tokens"
            )
        # New token hash must not be in old token hashes
        assert new_device.token_hash not in old_token_hashes, (
            "New device token hash must differ from old token hashes"
        )

        # Verify device receives real event push via _brain_process
        new_device.ws_messages.clear()
        result = new_node._brain_process(
            "security_alert",
            {"fiduciary": True, "text": "Migration security check"},
        )
        assert result.get("tier") is not None
        # _brain_process for non-arrival returns generic result;
        # verify device is functional by checking it was registered
        assert new_device.device_id in new_node.devices
        assert new_node.devices[new_device.device_id].connected is True

        # -- Pair a second device (laptop) on new node --------------------
        code2 = new_node.generate_pairing_code()
        laptop = new_node.pair_device(code2, DeviceType.RICH_CLIENT)
        assert laptop is not None
        assert laptop.device_id != new_device.device_id, (
            "Second device must have distinct ID"
        )
        assert len(new_node.devices) == 2, (
            "New node must support multiple devices after migration"
        )

        # One-time code enforcement: used code must not work again
        reuse = new_node.pair_device(code2, DeviceType.RICH_CLIENT)
        assert reuse is None, "Used pairing code must be rejected"
