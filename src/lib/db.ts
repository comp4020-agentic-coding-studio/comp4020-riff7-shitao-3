import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { type Booking, type Room, type WaitlistEntry, bookings, rooms, waitlist } from "./schema";

// One SQLite file is the app's whole persistent state. In production
// fly.toml points DATABASE_PATH at the machine's volume (/data), which is
// how state survives a reload and a redeploy; locally it defaults to an
// untracked file in .data/.
const path = process.env.DATABASE_PATH ?? "./.data/app.db";
mkdirSync(dirname(path), { recursive: true });

const client = new Database(path);
client.pragma("journal_mode = WAL");

export const db = drizzle(client);

// Migrations run at boot, on whatever machine holds the volume — the
// recommended shape for SQLite on Fly, where there's no separate machine to
// run them from. The flow: edit src/lib/schema.ts, `pnpm db:generate`,
// commit the migration it writes to drizzle/.
migrate(db, { migrationsFolder: "./drizzle" });

// The studio's rooms aren't user-created — seed them once. `onConflictDoNothing`
// (backed by the `rooms.name` unique constraint) makes this idempotent across
// every boot and redeploy, so it's safe to just run it here rather than in a
// one-off script.
const ROOM_NAMES = ["Hancock GSR 1", "Hancock GSR 2", "Chifley GSR 3", "Kambri Studio 4"];
for (const name of ROOM_NAMES) {
  db.insert(rooms).values({ name }).onConflictDoNothing().run();
}

export type { Booking, Room };

export function listRooms(): Room[] {
  return db.select().from(rooms).orderBy(rooms.id).all();
}

export function listBookings(date: string): Booking[] {
  return db.select().from(bookings).where(eq(bookings.date, date)).all();
}

// Everything a given cookie has booked from today onward, across the whole
// window — the answer to "wait, what did I book and where," which the grid
// itself can't show without clicking through up to fourteen date pages.
export function listBookingsByOwner(ownerToken: string, fromDate: string): Booking[] {
  return db
    .select()
    .from(bookings)
    .where(and(eq(bookings.ownerToken, ownerToken), gte(bookings.date, fromDate)))
    .orderBy(bookings.date, bookings.slot)
    .all();
}

// SQL LIKE treats %, _ and \ as pattern metacharacters, not literal text —
// unescaped, a query of just "%" (or "_") matches every row regardless of
// name, which is exactly the directory leak the empty-query guard below
// exists to prevent. Escaping them here (and declaring \ as the escape
// character in the query itself) makes a search for "%" look for a literal
// percent sign instead of "anything."
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// The grid only shows one date and /mine/ only shows one browser's own
// bookings — neither answers "is Priya's meeting still at 2pm Thursday," the
// question that actually needs a name search across the whole window. SQLite's
// LIKE is case-insensitive for ASCII by default, so no lower() is needed on
// either side. Requires a non-empty query rather than falling back to "list
// everything" — an empty search has no reason to exist and would otherwise
// turn this into a public directory of every name in the system.
export function searchBookings(query: string, fromDate: string): Booking[] {
  const trimmed = query.trim();
  if (trimmed === "") return [];
  const pattern = `%${escapeLikePattern(trimmed)}%`;
  return db
    .select()
    .from(bookings)
    .where(and(sql`${bookings.bookedBy} LIKE ${pattern} ESCAPE '\\'`, gte(bookings.date, fromDate)))
    .orderBy(bookings.date, bookings.slot)
    .all();
}

// Thrown when a booking loses a race for the same room/date/slot — the real
// failure mode this app exists to make visible, not a maybe.
export class SlotTakenError extends Error {}

export function createBooking(input: {
  roomId: number;
  date: string;
  slot: string;
  bookedBy: string;
  ownerToken: string;
}): Booking {
  try {
    return db.insert(bookings).values(input).returning().get();
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new SlotTakenError(`${input.slot} on ${input.date} is already booked`);
    }
    throw error;
  }
}

// Moves a booking to a different room/date/slot in one atomic UPDATE, rather
// than a cancel followed by a fresh create. That difference matters: cancel-
// then-rebook has a real window where the old slot is already given up and
// the new one turns out taken, losing the booking entirely. An UPDATE is
// still checked against the same (room_id, date, slot) unique constraint —
// SQLite enforces it on UPDATE exactly as it does on INSERT — so if the
// destination is taken, the statement fails and the original row is
// untouched: you keep what you had and find out the new slot's gone, instead
// of holding neither.
export function moveBooking(
  id: number,
  ownerToken: string,
  next: { roomId: number; date: string; slot: string },
): { previous: Booking; updated: Booking } | null {
  const previous = db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, id), eq(bookings.ownerToken, ownerToken)))
    .get();
  if (!previous) return null;

  try {
    const updated = db
      .update(bookings)
      .set({ roomId: next.roomId, date: next.date, slot: next.slot })
      .where(and(eq(bookings.id, id), eq(bookings.ownerToken, ownerToken)))
      .returning()
      .get();
    return { previous, updated };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new SlotTakenError(`${next.slot} on ${next.date} is already booked`);
    }
    throw error;
  }
}

// Deletes only if the id and owner token both match — the DB-level guarantee
// that mirrors the double-booking one: holding the id (guessable, sequential)
// is never enough on its own to cancel someone else's booking.
export function cancelBooking(id: number, ownerToken: string): Booking | null {
  const [cancelled] = db
    .delete(bookings)
    .where(and(eq(bookings.id, id), eq(bookings.ownerToken, ownerToken)))
    .returning()
    .all();
  return cancelled ?? null;
}

// Thrown when a browser tries to join a waitlist it's already on for this
// exact room/date/slot — the unique constraint's own failure, surfaced the
// same way SlotTakenError surfaces a booking collision.
export class AlreadyWaitingError extends Error {}

export function joinWaitlist(input: {
  roomId: number;
  date: string;
  slot: string;
  wantedBy: string;
  ownerToken: string;
}): WaitlistEntry {
  try {
    return db.insert(waitlist).values(input).returning().get();
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new AlreadyWaitingError(`already waiting for ${input.slot} on ${input.date}`);
    }
    throw error;
  }
}

// Called right after a slot frees up. FIFO by createdAt: the first name to
// join this exact room/date/slot's waitlist gets the slot, no polling and no
// race — this runs in the same synchronous, single-threaded call as the
// cancellation that freed the slot, so nobody else can book it in between.
// Returns the new booking so the caller can broadcast it, or null if nobody
// was waiting.
export function promoteWaitlist(roomId: number, date: string, slot: string): Booking | null {
  const next = db
    .select()
    .from(waitlist)
    .where(and(eq(waitlist.roomId, roomId), eq(waitlist.date, date), eq(waitlist.slot, slot)))
    .orderBy(asc(waitlist.createdAt), asc(waitlist.id))
    .get();
  if (!next) return null;

  db.delete(waitlist).where(eq(waitlist.id, next.id)).run();

  return db
    .insert(bookings)
    .values({
      roomId: next.roomId,
      date: next.date,
      slot: next.slot,
      bookedBy: next.wantedBy,
      ownerToken: next.ownerToken,
    })
    .returning()
    .get();
}
