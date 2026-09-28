import type { APIRoute } from "astro";
import { SlotTakenError, listRooms, moveBooking, promoteWaitlist } from "../../../../lib/db";
import { bus } from "../../../../lib/events";
import { OWNER_COOKIE } from "../../../../lib/owner";
import { SLOTS, isBookableDate } from "../../../../lib/slots";

// Reached only from /mine/ — the grid never needs it, since picking a
// different free cell there already is the edit. Same whitelist shape as
// cancel.ts, so a hand-built request can't turn this into an open redirect.
const RETURN_PATHS = new Set(["/", "/mine/"]);

// A moved booking is broadcast as the same "cancelled" + "booking" pair a
// cancel-then-rebook would produce, on purpose: every open tab already
// listens for both, so there's no third SSE event type to add or to keep in
// sync with a second frontend. The old cell frees, the new one fills — two
// events, not one, because they may land on two different dates/rooms that
// no single event could describe.
export const POST: APIRoute = async ({ params, request, cookies, redirect }) => {
  const id = Number(params.id);
  const token = cookies.get(OWNER_COOKIE)?.value;
  const form = await request.formData();
  const returnTo = RETURN_PATHS.has(String(form.get("returnTo"))) ? String(form.get("returnTo")) : "/mine/";

  const roomId = Number(form.get("roomId"));
  const date = String(form.get("date") ?? "");
  const slot = String(form.get("slot") ?? "");

  // /mine/ can list several bookings at once, each with its own Move form —
  // naming which one an error belongs to (mine.astro falls back to a
  // page-level banner if this id isn't one of the visitor's own bookings)
  // lets the error attach to the right row instead of one unscoped banner.
  const errorParam = id ? `&booking=${id}` : "";

  // Same reasoning as bookings.ts: the form only ever sends a real room's id
  // via its own <select>, but a hand-built request could send anything, and
  // an unvalidated roomId would otherwise hit the database's foreign-key
  // constraint as a raw 500 instead of this redirect.
  const validRoomIds = new Set(listRooms().map((room) => room.id));
  if (
    !id ||
    !token ||
    !roomId ||
    !date ||
    !slot ||
    !validRoomIds.has(roomId) ||
    !(SLOTS as readonly string[]).includes(slot)
  ) {
    return redirect(`${returnTo}?error=missing${errorParam}`, 303);
  }
  if (!isBookableDate(date)) {
    return redirect(`${returnTo}?error=date${errorParam}`, 303);
  }

  try {
    const moved = moveBooking(id, token, { roomId, date, slot });
    if (!moved) {
      return redirect(`${returnTo}?error=notfound${errorParam}`, 303);
    }
    bus.emit("cancelled", moved.previous);
    bus.emit("booking", moved.updated);

    // Same promotion a plain cancel does — the old slot freed here too, so
    // whoever's been waiting longest for it gets moved in before anyone else
    // can grab it.
    const promoted = promoteWaitlist(moved.previous.roomId, moved.previous.date, moved.previous.slot);
    if (promoted) {
      bus.emit("booking", promoted);
    }
  } catch (error) {
    if (error instanceof SlotTakenError) {
      return redirect(`${returnTo}?error=taken${errorParam}`, 303);
    }
    throw error;
  }

  return redirect(returnTo, 303);
};
