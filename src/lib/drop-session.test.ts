import assert from "node:assert/strict";
import { test } from "node:test";
import { createDropSession, isDragLeavingWindow } from "./drop-session.ts";

const viewport = { width: 1280, height: 720 };
const inside = () => true;
const outside = () => false;

test("isDragLeavingWindow keeps the session when relatedTarget is still in the document", () => {
  assert.equal(
    isDragLeavingWindow({ relatedTarget: {}, clientX: 400, clientY: 300 }, viewport, inside),
    false,
  );
});

test("isDragLeavingWindow does not end the session on overlay retarget (null relatedTarget, cursor still inside)", () => {
  assert.equal(
    isDragLeavingWindow({ relatedTarget: null, clientX: 400, clientY: 300 }, viewport, outside),
    false,
  );
});

test("isDragLeavingWindow ends the session when the cursor leaves the viewport", () => {
  assert.equal(
    isDragLeavingWindow({ relatedTarget: null, clientX: 0, clientY: 80 }, viewport, outside),
    true,
  );
  assert.equal(
    isDragLeavingWindow({ relatedTarget: null, clientX: 40, clientY: -2 }, viewport, outside),
    true,
  );
  assert.equal(
    isDragLeavingWindow({ relatedTarget: null, clientX: 1280, clientY: 80 }, viewport, outside),
    true,
  );
});

test("drop session survives Safari-style leave-then-enter when moving onto the overlay", () => {
  const session = createDropSession();
  const body = { id: "body" };
  const overlay = { id: "overlay" };

  session.enter(body);
  const endedOnRetarget = session.leave(
    { target: body, relatedTarget: overlay, clientX: 640, clientY: 360 },
    viewport,
    inside,
  );
  assert.equal(endedOnRetarget, false);

  session.enter(overlay);
  assert.equal(session.active, true);
});

test("drop session ends only after the last target leaves the window", () => {
  const session = createDropSession();
  const body = { id: "body" };
  const overlay = { id: "overlay" };

  session.enter(body);
  session.enter(overlay);
  assert.equal(
    session.leave({ target: body, relatedTarget: overlay, clientX: 640, clientY: 360 }, viewport, inside),
    false,
  );
  assert.equal(
    session.leave({ target: overlay, relatedTarget: null, clientX: -1, clientY: 20 }, viewport, outside),
    true,
  );
});

test("drop session ignores the 0,0 first-event coords until a real pointer position arrives", () => {
  const session = createDropSession();
  assert.equal(session.acceptCoords(0, 0), false);
  assert.equal(session.acceptCoords(320, 180), true);
  assert.equal(session.acceptCoords(0, 0), true);
});
