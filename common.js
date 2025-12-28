// common.js (Genius Mode)
// Firebase + shared room logic for Host + Student pages

import { firebaseConfig } from "./firebaseConfig.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  onSnapshot,
  serverTimestamp,
  runTransaction,
  arrayUnion
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

function roomRef(roomId) {
  return doc(db, "quizmasRooms", roomId);
}

export async function ensureRoom(roomId) {
  const ref = roomRef(roomId);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    await setDoc(ref, {
      createdAt: serverTimestamp(),

      // Students connected to this room
      students: [],

      // Current question state
      question: {
        mode: "verbal",      // "verbal" | "text"
        text: "",
        answerMode: "buzz", // "buzz" | "typed_all"
        answers: {},
        answersList: [],        // typed_all answers keyed by encoded student name
        askedAt: null
      },

      // Buzzer state (first buzz wins)
      buzz: {
        lockedBy: null,
        lockedAt: null,
        answer: null
      },

      // Cold call state
      coldCall: {
        current: null,
        used: []
      }
    });
    return;
  }

  // Backfill missing fields for older rooms
  const data = snap.data() || {};
  const patch = {};

  if (!Array.isArray(data.students)) patch.students = [];
  if (!data.question) {
    patch.question = { mode: "verbal", text: "", answerMode: "buzz", answers: {},
        answersList: [], askedAt: null };
  } else {
    if (!("mode" in data.question)) patch["question.mode"] = "verbal";
    if (!("text" in data.question)) patch["question.text"] = "";
    if (!("answerMode" in data.question)) patch["question.answerMode"] = "buzz";
    if (!("answers" in data.question) || typeof data.question.answers !== "object") patch["question.answers"] = {};
    if (!("askedAt" in data.question)) patch["question.askedAt"] = null;
    // legacy field
    if (!("allowTyping" in data.question)) patch["question.allowTyping"] = false;
  }

  if (!data.buzz) patch.buzz = { lockedBy: null, lockedAt: null, answer: null };
  else {
    if (!("lockedBy" in data.buzz)) patch["buzz.lockedBy"] = null;
    if (!("lockedAt" in data.buzz)) patch["buzz.lockedAt"] = null;
    if (!("answer" in data.buzz)) patch["buzz.answer"] = null;
  }

  if (!data.coldCall) patch.coldCall = { current: null, used: [] };
  else {
    if (!("current" in data.coldCall)) patch["coldCall.current"] = null;
    if (!Array.isArray(data.coldCall.used)) patch["coldCall.used"] = [];
  }

  if (Object.keys(patch).length) {
    await updateDoc(ref, patch);
  }
}

export function listenRoom(roomId, cb) {
  const ref = roomRef(roomId);
  return onSnapshot(ref, (snap) => cb(snap.exists() ? snap.data() : null));
}

export async function registerStudent(roomId, studentName) {
  const name = String(studentName || "").trim();
  if (!name) throw new Error("Student name required");
  const ref = roomRef(roomId);

  await updateDoc(ref, {
    students: arrayUnion(name)
  });
}

export async function setQuestion(roomId, { mode, text, allowTyping }) {
  const ref = roomRef(roomId);
  await updateDoc(ref, {
    "question.mode": mode === "text" ? "text" : "verbal",
    "question.text": mode === "text" ? String(text || "").trim() : "",
    "question.answerMode": mode === "text" ? "typed_all" : "buzz",
    "question.answers": {},
    "question.answersList": [],
    "question.answersList": [],
    "question.allowTyping": false, // legacy (unused)
    "question.askedAt": serverTimestamp()
  });

  // New question: clear buzz lock + answer + cold-call current
  await updateDoc(ref, {
    "buzz.lockedBy": null,
    "buzz.lockedAt": null,
    "buzz.answer": null,
    "coldCall.current": null
  });
}

export async function clearQuestion(roomId) {
  const ref = roomRef(roomId);
  await updateDoc(ref, {
    "question.text": "",
    "question.mode": "verbal",
    "question.answerMode": "buzz",
    "question.answers": {},
    "question.answersList": [],
    "question.allowTyping": false,
    "question.askedAt": serverTimestamp(),
    "buzz.lockedBy": null,
    "buzz.lockedAt": null,
    "buzz.answer": null,
    "coldCall.current": null
  });
}

export async function buzz(roomId, studentName) {
  const name = String(studentName || "").trim();
  if (!name) return;

  const ref = roomRef(roomId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("Room not found");
    const data = snap.data();
    const qMode = data?.question?.answerMode || "buzz";
    if (qMode === "typed_all") return;
    const lockedBy = data?.buzz?.lockedBy ?? null;
    if (lockedBy) return; // already locked
    tx.update(ref, {
      "buzz.lockedBy": name,
      "buzz.lockedAt": serverTimestamp(),
      "buzz.answer": null
    });
  });
}

export async function submitAnswer(roomId, studentName, answerText) {
  const name = String(studentName || "").trim();
  const answer = String(answerText || "").trim();
  if (!name) return;

  const ref = roomRef(roomId);
  const key = encodeURIComponent(name).replaceAll(".", "%2E");

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("Room not found");
    const data = snap.data();
    const qMode = data?.question?.answerMode || "buzz";

    if (qMode === "typed_all") {
      // Everyone can submit a typed answer (no buzzing required)
      tx.update(ref, {
        [`question.answers.${key}`]: { name, answer, submittedAt: serverTimestamp() },
        "question.answersList": arrayUnion({ name, answer })
      });
      return;
    }

    // Buzz mode: only the buzzer winner can submit an answer
    const lockedBy = data?.buzz?.lockedBy ?? null;
    if (lockedBy !== name) return;
    tx.update(ref, {
      "buzz.answer": answer
    });
  });
}


export async function resetBuzz(roomId) {
  const ref = roomRef(roomId);
  await updateDoc(ref, {
    "buzz.lockedBy": null,
    "buzz.lockedAt": null,
    "buzz.answer": null
  });
}

export async function coldCallPick(roomId) {
  const ref = roomRef(roomId);

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("Room not found");
    const data = snap.data() || {};
    const students = Array.isArray(data.students) ? data.students : [];
    if (!students.length) throw new Error("No students connected");

    const used = Array.isArray(data?.coldCall?.used) ? data.coldCall.used : [];
    const available = students.filter((s) => !used.includes(s));

    // If exhausted, reset used pool
    const pool = available.length ? available : students;
    const newUsed = available.length ? used.slice() : [];

    const pick = pool[Math.floor(Math.random() * pool.length)];
    newUsed.push(pick);

    tx.update(ref, {
      "coldCall.current": pick,
      "coldCall.used": newUsed
    });
  });
}

export async function coldCallClear(roomId) {
  const ref = roomRef(roomId);
  await updateDoc(ref, {
    "coldCall.current": null
  });
}
