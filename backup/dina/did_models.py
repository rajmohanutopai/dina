"""DID Document models — W3C-compliant Pydantic schemas for Dina's identity."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class VerificationMethod(BaseModel):
    """A single verification method inside a DID Document."""

    id: str
    type: str
    controller: str
    public_key_multibase: str = Field(alias="publicKeyMultibase")

    model_config = ConfigDict(populate_by_name=True)


class DIDDocument(BaseModel):
    """A minimal W3C DID Document for Dina's self-sovereign identity."""

    context: list[str] = Field(
        alias="@context",
        default=[
            "https://www.w3.org/ns/did/v1",
            "https://w3id.org/security/suites/ed25519-2020/v1",
        ],
    )
    id: str
    verification_method: list[VerificationMethod] = Field(alias="verificationMethod")
    authentication: list[str]
    assertion_method: list[str] = Field(alias="assertionMethod")

    model_config = ConfigDict(populate_by_name=True)
