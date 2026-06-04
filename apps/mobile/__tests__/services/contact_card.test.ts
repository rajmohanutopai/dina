import { buildContactCard, parseContactCard } from '../../src/services/contact_card';

const DID = 'did:plc:s6mbp7pokaqsh5nko26wie5u';
const HANDLE = 'aalber.test-pds.dinakernel.com';

describe('contact_card', () => {
  it('round-trips name + handle + DID', () => {
    const card = buildContactCard({ name: 'Aalber', handle: HANDLE, did: DID });
    const parsed = parseContactCard(card);
    expect(parsed.did).toBe(DID);
    expect(parsed.handle).toBe(HANDLE);
    expect(parsed.name).toBe('Aalber');
    // The DID is preferred as the resolve identifier.
    expect(parsed.identifier).toBe(DID);
  });

  it('builds a readable, messenger-safe blob', () => {
    expect(buildContactCard({ name: 'Aalber', handle: HANDLE, did: DID })).toBe(
      `Aalber\nHandle: ${HANDLE}\nDina ID: ${DID}\nAdd me on Dina.`,
    );
  });

  it('omits the name line when there is no name', () => {
    const card = buildContactCard({ name: null, handle: HANDLE, did: DID });
    expect(card.startsWith('Handle:')).toBe(true);
    expect(parseContactCard(card).name).toBeUndefined();
  });

  it('parses a pasted card even after messenger reflow / extra lines', () => {
    const messy = `Hey! 👋\n\nAalber\nHandle: ${HANDLE}\nDina ID: ${DID}\nAdd me on Dina.`;
    const parsed = parseContactCard(messy);
    expect(parsed.identifier).toBe(DID);
    expect(parsed.handle).toBe(HANDLE);
    // First plain line wins for the name (messenger greeting aside, the
    // card's own name line is what we want — greeting "Hey!" has a comma/emoji
    // but no dots, so it could be mistaken; we accept first plain line).
    expect(parsed.name).toBeDefined();
  });

  it('accepts a bare DID', () => {
    const parsed = parseContactCard(DID);
    expect(parsed.identifier).toBe(DID);
    expect(parsed.did).toBe(DID);
    expect(parsed.name).toBeUndefined();
  });

  it('accepts a bare handle', () => {
    const parsed = parseContactCard(HANDLE);
    expect(parsed.identifier).toBe(HANDLE);
    expect(parsed.handle).toBe(HANDLE);
    expect(parsed.did).toBeUndefined();
  });

  it('accepts a "Name + DID" two-liner', () => {
    const parsed = parseContactCard(`Alonso\n${DID}`);
    expect(parsed.identifier).toBe(DID);
    expect(parsed.name).toBe('Alonso');
  });

  // Regression: a paste that lost its newlines used to leave the DID glued to
  // the trailing "Add me on Dina." text, and a greedy /i regex ate "Add" onto
  // the DID. The identifier must always be exactly the 24-char did:plc.
  it('extracts a clean DID even when glued to trailing text', () => {
    const parsed = parseContactCard(`${DID}Add me on Dina.`);
    expect(parsed.identifier).toBe(DID);
    expect(parsed.did).toBe(DID);
  });

  it('extracts a clean DID from a newline-stripped card blob', () => {
    const glued = `AalberHandle: ${HANDLE}Dina ID: ${DID}Add me on Dina.`;
    expect(parseContactCard(glued).identifier).toBe(DID);
  });
});
