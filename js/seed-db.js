// Intentionally does not seed mock catalogue data. Production data is managed
// directly in the existing Firestore collections and company subcollections.
export async function seedFirestoreDatabase() {
  throw new Error('Mock seeding is disabled. Manage live products and homepage content in Firestore.');
}
