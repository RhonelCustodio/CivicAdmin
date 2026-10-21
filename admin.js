import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { firebaseConfig } from "./firebase-config/firebase-config.js";
import {
  getFirestore,
  collection,
  addDoc,
  onSnapshot,
  query,
  orderBy,
  doc,
  deleteDoc,
  updateDoc,
  getDocs,
  getDoc,
  where,
  limit,
  serverTimestamp,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const STATUS = {
  APPROVED: "Approved",
  REJECTED: "Rejected",
  PENDING: "Pending",
  CONFIRMED: "Confirmed",
  COMPLETED: "Completed",
  REGISTERED: "Registered",
  CANCELLED: "Cancelled",
  TRASHED: "Trashed",
  REFUNDED: "Refunded",
};

/* ============================================================
   ADMIN UPDATE PACK — mirrored from Resident Hub / Organizer Console
   (status normalizer, retry buffer, boot loader,
   categorized donation details)
   ============================================================ */

/**
 * REJECTION BUG FIX: status values stored by different panels/legacy
 * records vary in capitalization or wording ("rejected", "Declined",
 * paymentStatus-only updates…). All donation status displays funnel
 * through this normalizer so records never land in the wrong bucket.
 */
function normalizeStatus(rawValue) {
  const s = String(rawValue ?? "")
    .trim()
    .toLowerCase();
  if (
    [
      "approved",
      "approve",
      "confirmed",
      "confirm",
      "completed",
      "complete",
      "verified",
      "success",
      "successful",
      "accepted",
      "accept",
    ].includes(s)
  )
    return STATUS.APPROVED;
  if (
    [
      "rejected",
      "reject",
      "declined",
      "decline",
      "denied",
      "deny",
      "failed",
      "invalid",
    ].includes(s)
  )
    return STATUS.REJECTED;
  if (
    [
      "refunded",
      "refund",
    ].includes(s)
  )
    return STATUS.REFUNDED;
  return STATUS.PENDING;
}

/** Resolve the effective decision status of a record (honors paymentStatus
 *  when the primary status field was left pending). */
function effectiveStatus(data) {
  const primary = normalizeStatus(data?.status);
  if (primary !== STATUS.PENDING) return primary;
  if (data?.paymentStatus !== undefined && data?.paymentStatus !== null) {
    const secondary = normalizeStatus(data.paymentStatus);
    if (secondary !== STATUS.PENDING) return secondary;
  }
  return STATUS.PENDING;
}

/**
 * SLOW INTERNET BUFFER: retries a Firestore read with exponential backoff
 * so one dropped packet doesn't end the admin session or fail a login.
 */
async function withRetryBuffer(taskFn, options = {}) {
  const { retries = 3, baseDelay = 1200, label = "firestore" } = options;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await taskFn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const wait = baseDelay * Math.pow(1.6, attempt);
        console.warn(
          `[retry-buffer] ${label} attempt ${attempt + 1} failed, retrying in ${Math.round(wait)}ms…`,
          err?.code || err?.message || err,
        );
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

// ===== BOOT LOADER (slow-internet aware) =====
let bootLoaderSlowTimer = null,
  bootLoaderFailsafeTimer = null,
  bootLoaderDone = false;

function showBootLoader() {
  const overlay = document.getElementById("page-loading-overlay");
  if (!overlay || bootLoaderDone) return;
  overlay.classList.add("active");
  bootLoaderSlowTimer = setTimeout(() => {
    const sub = overlay.querySelectorAll("p")[1];
    if (sub)
      sub.innerHTML =
        '<i class="fa-solid fa-wifi mr-1"></i>Slow connection detected — still retrieving your data, please wait…';
  }, 8000);
  bootLoaderFailsafeTimer = setTimeout(() => hideBootLoader(), 25000);
}

function hideBootLoader() {
  bootLoaderDone = true;
  if (bootLoaderSlowTimer) clearTimeout(bootLoaderSlowTimer);
  if (bootLoaderFailsafeTimer) clearTimeout(bootLoaderFailsafeTimer);
  document.getElementById("page-loading-overlay")?.classList.remove("active");
}

/** Compact "category + qty" details line for item donations. */
function formatItemDonationDetails(data) {
  const parts = [];
  if (data?.itemCategory) parts.push(String(data.itemCategory));
  const qty = parseFloat(data?.itemQuantity);
  if (!Number.isNaN(qty) && qty > 0) {
    const unit = String(data?.itemUnit || "pcs").trim();
    parts.push(`${qty} ${unit}`);
  }
  const desc = String(data?.itemDescription || data?.item || "").trim();
  if (desc) parts.push(desc);
  return parts.join(" · ");
}

/** Friendly payment-method label (ported from the Organizer Console —
 *  without it, item donations were mislabeled "E-Wallet"). */
function formatPaymentMethodName(method) {
  if (!method) return "E-Wallet / Bank";
  const m = String(method).toLowerCase();
  if (m === "gcash") return "GCash";
  if (m === "paymaya" || m === "maya") return "PayMaya / Maya";
  if (m === "bank_transfer" || m === "bank") return "Bank Transfer";
  if (m === "cash" || m === "cash payment") return "Cash Payment";
  return method.charAt(0).toUpperCase() + method.slice(1);
}

let digitalCheckInRegistry = [],
  pendingConfirmCallback = null,
  loggedInAdmin = null,
  selectedResidentId = null,
  editingAnnouncementImage = "",
  allResidents = [];
let activityLogSortField = "date",
  activityLogSortDirection = "desc",
  allActivityLogs = [];
let donationSortField = "date",
  donationSortDirection = "desc",
  allDonations = [];
let volunteerSortField = "date",
  volunteerSortDirection = "desc",
  allVolunteers = [];
let allContactMessages = [];

function newChipHtml() {
  return '<span class="item-new-chip">NEW</span>';
}

function updateNavBadge(tabId, count, title) {
  const badge = document.getElementById("badge-" + tabId);
  if (!badge) return;
  const n = Number(count) || 0;
  if (n > 0) {
    const nextLabel = n > 99 ? "99+" : String(n);
    const prevLabel = (badge.textContent || "").trim();
    badge.textContent = nextLabel;
    badge.classList.remove("hidden");
    badge.setAttribute("aria-hidden", "false");
    badge.title = title || n + " new item(s)";
    if (prevLabel !== nextLabel) {
      badge.classList.remove("nav-badge-pop");
      void badge.offsetWidth;
      badge.classList.add("nav-badge-pop");
    }
  } else {
    badge.textContent = "0";
    badge.classList.add("hidden");
    badge.setAttribute("aria-hidden", "true");
    badge.removeAttribute("title");
  }
}

function getNewEventJoins() {
  return allActivityLogs.filter((log) => log.status === STATUS.REGISTERED);
}

function renderNewEventJoinsPanel() {
  const panel = document.getElementById("new-event-joins-panel");
  const list = document.getElementById("new-event-joins-list");
  const countEl = document.getElementById("new-event-joins-count");
  if (!panel || !list) return;
  const joins = getNewEventJoins().slice().sort((a, b) => {
    const dA = a.timestamp?.toDate ? a.timestamp.toDate() : new Date(a.timestamp || 0);
    const dB = b.timestamp?.toDate ? b.timestamp.toDate() : new Date(b.timestamp || 0);
    return dB - dA;
  });
  if (!joins.length) {
    panel.classList.add("hidden");
    list.innerHTML = "";
    return;
  }
  panel.classList.remove("hidden");
  if (countEl) countEl.textContent = joins.length + " new";
  list.innerHTML = joins
    .map((log) => {
      const when = log.timestamp ? formatFirebaseTimestamp(log.timestamp) : "Just now";
      const name = log.residentName || "Resident";
      const eventTitle = log.eventTitle || "an event";
      const escId = (log.id || "").replace(/'/g, "\\'");
      const escName = name.replace(/'/g, "\\'");
      const escEvent = eventTitle.replace(/'/g, "\\'");
      return (
        '<div class="flex items-center justify-between gap-3 bg-white border border-amber-200 rounded-xl px-3.5 py-2.5">' +
        '<div class="min-w-0"><p class="text-sm font-bold text-slate-900 truncate">' +
        name +
        '</p><p class="text-xs text-slate-500 truncate">joined <span class="font-semibold text-victoria-blue">' +
        eventTitle +
        "</span></p></div>" +
        '<div class="text-right shrink-0 flex items-center gap-2">' +
        newChipHtml() +
        '<button type="button" onclick="rejectParticipantRegistration(\'' + escId + '\', \'' + escName + '\', \'' + escEvent + '\')" class="text-xs px-2.5 py-1 rounded bg-rose-50 text-rose-600 hover:bg-rose-600 hover:text-white font-semibold transition-all inline-flex items-center gap-1 shadow-sm"><i class="fa-solid fa-xmark"></i>Reject</button>' +
        '<p class="text-[10px] text-slate-400">' +
        when +
        "</p></div></div>"
      );
    })
    .join("");
}

function refreshActionBadges() {
  const pendingFeedback = allContactMessages.filter((m) => {
    const status = m.status || "Pending";
    return status === "Pending";
  }).length;
  const pendingDonations = allDonations.filter((d) => {
    const status = d.status || STATUS.PENDING;
    return status === STATUS.PENDING;
  }).length;
  const pendingVolunteers = allVolunteers.filter((v) => {
    if (v.status === STATUS.TRASHED) return false;
    const status = v.status || STATUS.PENDING;
    return status === STATUS.PENDING;
  }).length;
  const eventJoins = getNewEventJoins().length;

  updateNavBadge(
    "contacts",
    pendingFeedback,
    pendingFeedback === 1
      ? "1 new feedback waiting for review"
      : pendingFeedback + " new feedback waiting for review",
  );
  updateNavBadge(
    "donations",
    pendingDonations,
    pendingDonations === 1
      ? "1 new donation to verify"
      : pendingDonations + " new donations to verify",
  );
  updateNavBadge(
    "volunteers",
    pendingVolunteers,
    pendingVolunteers === 1
      ? "1 new volunteer application"
      : pendingVolunteers + " new volunteer applications",
  );
  updateNavBadge(
    "hours",
    eventJoins,
    eventJoins === 1
      ? "1 new event registration"
      : eventJoins + " new event registrations",
  );
  renderNewEventJoinsPanel();
}

function getAdminDisplayName() {
  if (loggedInAdmin?.name) return loggedInAdmin.name;
  if (loggedInAdmin?.email)
    return loggedInAdmin.email
      .split("@")[0]
      .replace(/[._-]/g, " ")
      .replace(/\b\w/g, (l) => l.toUpperCase());
  return "System Administrator";
}
function formatFirebaseTimestamp(timestamp) {
  if (!timestamp) return "N/A";
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return (
    date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }) +
    " at " +
    date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    })
  );
}
function formatTime(timeValue) {
  if (!timeValue) return "";
  if (typeof timeValue === "string" && timeValue.includes(":")) {
    const [hours, minutes] = timeValue.split(":");
    const h = parseInt(hours);
    const ampm = h >= 12 ? "PM" : "AM";
    return `${h % 12 || 12}:${minutes} ${ampm}`;
  }
  return timeValue;
}
function saveAdminSession(adminData) {
  localStorage.setItem(
    "barangayAdmin",
    JSON.stringify({
      id: adminData.id,
      name: adminData.name || getAdminDisplayName(),
      role: adminData.role || "admin",
      email: adminData.email,
    }),
  );
}
function clearAdminSession() {
  localStorage.removeItem("barangayAdmin");
  sessionStorage.removeItem("adminActiveTab");
}
function getSavedAdminSession() {
  const s = localStorage.getItem("barangayAdmin");
  if (s) {
    try {
      return JSON.parse(s);
    } catch (e) {
      clearAdminSession();
      return null;
    }
  }
  return null;
}
function saveActiveTab(tabId) {
  sessionStorage.setItem("adminActiveTab", tabId);
}
function getSavedActiveTab() {
  return sessionStorage.getItem("adminActiveTab") || "announcements";
}
window.showLoading = function () {
  const el = document.getElementById("global-loading");
  if (el) el.classList.remove("hidden");
};
window.hideLoading = function () {
  const el = document.getElementById("global-loading");
  if (el) el.classList.add("hidden");
};
window.showAdminAlert = function (title, message, isSuccess = true) {
  const box = document.getElementById("admin-alert-icon"),
    alertTitle = document.getElementById("admin-alert-title"),
    alertMsg = document.getElementById("admin-alert-msg"),
    alertModal = document.getElementById("admin-alert-modal");
  if (!box || !alertTitle || !alertMsg || !alertModal) {
    alert(`${isSuccess ? "Success" : "Error"}: ${title}\n${message}`);
    return;
  }
  if (isSuccess) {
    box.className =
      "w-14 h-14 bg-emerald-50 text-emerald-500 rounded-2xl flex items-center justify-center mx-auto mb-4 text-xl shadow-sm";
    box.innerHTML = '<i class="fa-solid fa-circle-check"></i>';
  } else {
    box.className =
      "w-14 h-14 bg-rose-50 text-rose-500 rounded-2xl flex items-center justify-center mx-auto mb-4 text-xl shadow-sm";
    box.innerHTML = '<i class="fa-solid fa-circle-xmark"></i>';
  }
  alertTitle.innerText = title;
  alertMsg.innerText = message;
  window.openModal(alertModal);
};
window.showConfirmPopup = function (title, text, proceedCallback) {
  const confirmTitle = document.getElementById("confirm-title"),
    confirmMsg = document.getElementById("confirm-msg"),
    confirmModal = document.getElementById("confirm-modal");
  if (!confirmTitle || !confirmMsg || !confirmModal) {
    if (confirm(text) && typeof proceedCallback === "function")
      proceedCallback();
    return;
  }
  confirmTitle.innerText = title;
  confirmMsg.innerText = text;
  window.openModal(confirmModal);
  pendingConfirmCallback = proceedCallback;
};
window.openModal = function (id) {
  const modal = typeof id === "string" ? document.getElementById(id) : id;
  if (modal) {
    modal.style.display = "flex";
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }
};
window.closeModal = function (id) {
  const modal = typeof id === "string" ? document.getElementById(id) : id;
  if (modal) {
    modal.style.display = "none";
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }
};
window._reopenModal = function (id) {
  const modal = typeof id === "string" ? document.getElementById(id) : id;
  if (modal) {
    modal.style.display = "flex";
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }
};
window.toggleModal = function (id) {
  const modal = typeof id === "string" ? document.getElementById(id) : id;
  if (!modal) return;
  if (modal.classList.contains("hidden") || modal.style.display === "none") {
    window.openModal(modal);
  } else {
    window.closeModal(modal);
  }
};
async function createNotification(
  residentId,
  title,
  message,
  type = "general",
) {
  if (!residentId) return;
  try {
    await addDoc(collection(db, "notifications"), {
      residentId,
      title,
      message,
      type,
      read: false,
      createdAt: serverTimestamp(),
    });
  } catch (e) {
    console.error("Failed to create notification:", e);
  }
}

// ========================================== ACTIVITY LOG FUNCTIONS ==========================================
window.sortActivityLogs = function (value) {
  const [f, d] = value.split("-");
  activityLogSortField = f;
  activityLogSortDirection = d;
  const sd = document.getElementById("activity-sort-select");
  if (sd) sd.value = value;
  renderSortedActivityLogs();
  const fd = document.getElementById("activity-filter-select");
  if (fd?.value !== "all") window.filterActivityLogs(fd?.value || "all");
};
window.filterActivityLogs = function (filter) {
  const d = document.getElementById("activity-filter-select");
  if (filter && d && d.value !== filter) d.value = filter;
  const selectedStatus = (d?.value || "all").toLowerCase();
  const searchInput = document.getElementById("activity-search-input");
  const query = (searchInput?.value || "").trim().toLowerCase();

  let visible = 0;
  document.querySelectorAll(".activity-log-row").forEach((r) => {
    const rs = (r.getAttribute("data-status") || "").toLowerCase();
    const resident = (r.getAttribute("data-resident") || "").toLowerCase();
    const event = (r.getAttribute("data-event") || "").toLowerCase();
    const rowText = r.textContent.toLowerCase();

    let matchesStatus = false;
    if (selectedStatus === "all") matchesStatus = true;
    else if (selectedStatus === "completed" || selectedStatus === "credited")
      matchesStatus = rs === STATUS.COMPLETED.toLowerCase();
    else matchesStatus = rs === selectedStatus;

    const matchesQuery =
      !query ||
      resident.includes(query) ||
      event.includes(query) ||
      rowText.includes(query);

    const show = matchesStatus && matchesQuery;
    r.style.display = show ? "" : "none";
    if (show) visible++;
  });

  const rc = document.getElementById("activity-result-count");
  if (rc) {
    rc.textContent = `${visible} ${visible === 1 ? "log" : "logs"}`;
  }
};

// RECOMMENDATION: Activity audit logs shouldn't be bulk-deleted to avoid negligence & misuse.
window.clearActivityLogs = function () {
  window.showAdminAlert(
    "Action Protected",
    "Bulk deletion of activity logs is disabled to avoid negligence and maintain accountability. You can reject or delete specific participant records individually.",
    false,
  );
};

// Participant registration rejection & specific record actions
window.rejectParticipantRegistration = function (id, residentName = "Resident", eventTitle = "the event") {
  window.showConfirmPopup(
    "Reject Participant Registration?",
    `Are you sure you want to reject the registration of "${residentName}" for "${eventTitle}"?`,
    async () => {
      window.showLoading();
      try {
        const participantRef = doc(db, "participants", id);
        const snap = await getDoc(participantRef);
        if (!snap.exists()) {
          window.hideLoading();
          window.showAdminAlert("Error", "Participant record not found.", false);
          return;
        }
        const data = snap.data();
        await updateDoc(participantRef, {
          status: STATUS.REJECTED,
          rejectedAt: serverTimestamp(),
          rejectedBy: getAdminDisplayName(),
          rejectedById: loggedInAdmin?.id || "system",
        });
        if (data.residentId) {
          await createNotification(
            data.residentId,
            "Event Registration Rejected",
            `Your registration for "${data.eventTitle || eventTitle}" has been rejected by administration.`,
            "participant_rejected",
          );
        }
        window.showAdminAlert("Registration Rejected", `Successfully rejected registration for ${residentName}.`, true);
      } catch (err) {
        window.showAdminAlert("Error", err.message, false);
      } finally {
        window.hideLoading();
      }
    },
  );
};

window.resetParticipantRegistration = function (id, residentName = "Resident") {
  window.showConfirmPopup(
    "Reset Registration?",
    `Reset registration status for "${residentName}" back to Registered?`,
    async () => {
      window.showLoading();
      try {
        await updateDoc(doc(db, "participants", id), {
          status: STATUS.REGISTERED,
          resetAt: serverTimestamp(),
          resetBy: getAdminDisplayName(),
        });
        window.showAdminAlert("Success", "Registration status reset to Registered.", true);
      } catch (err) {
        window.showAdminAlert("Error", err.message, false);
      } finally {
        window.hideLoading();
      }
    },
  );
};

window.deleteParticipantRecord = function (id, residentName = "Resident", eventTitle = "the event") {
  window.showConfirmPopup(
    "Move to Trash?",
    `Are you sure you want to move the registration record for "${residentName}" (${eventTitle}) to trash? You can restore it later from the Trash view.`,
    async () => {
      window.showLoading();
      try {
        const snap = await getDoc(doc(db, "participants", id));
        const currentStatus = snap.exists() ? (snap.data().status || STATUS.REGISTERED) : STATUS.REGISTERED;
        await updateDoc(doc(db, "participants", id), {
          status: STATUS.TRASHED,
          previousStatus: currentStatus,
          trashedAt: serverTimestamp(),
          trashedBy: getAdminDisplayName(),
          trashedById: loggedInAdmin?.id || "system",
        });
        window.showAdminAlert("Moved to Trash", `Registration record for "${residentName}" has been moved to trash.`, true);
      } catch (err) {
        window.showAdminAlert("Error", err.message, false);
      } finally {
        window.hideLoading();
      }
    },
  );
};

window.viewTrashLogs = async function () {
  window.showLoading();
  try {
    const s = await getDocs(
      query(
        collection(db, "participants"),
        where("status", "==", STATUS.TRASHED),
      ),
    );
    const tl = [];
    s.forEach((d) => {
      tl.push({ id: d.id, ...d.data() });
    });
    tl.sort((a, b) => {
      const dA = a.trashedAt?.toDate
        ? a.trashedAt.toDate()
        : new Date(a.trashedAt || 0);
      const dB = b.trashedAt?.toDate
        ? b.trashedAt.toDate()
        : new Date(b.trashedAt || 0);
      return dB - dA;
    });
    const em = document.getElementById("trash-logs-modal");
    if (em) em.remove();
    const modal = document.createElement("div");
    modal.className =
      "fixed inset-0 bg-gray-900/80 backdrop-blur-sm flex items-center justify-center p-4 z-[180] overflow-hidden";
    modal.id = "trash-logs-modal";
    modal.addEventListener("click", function (e) {
      if (e.target === modal) modal.remove();
    });
    let tr = "";
    if (tl.length === 0) {
      tr = `<tr><td colspan="5" class="px-4 py-10 text-center text-gray-400"><i class="fa-solid fa-trash-can text-4xl mb-3 block text-gray-300"></i><p class="text-lg font-bold text-gray-500">Trash is Empty</p></td></tr>`;
    } else {
      tl.forEach((log) => {
        const id = log.id;
        let ab = "";
        if (log.previousStatus === STATUS.REGISTERED)
          ab =
            '<span class="px-2 py-0.5 rounded text-xs font-bold text-slate-700">Registered</span>';
        else if (log.previousStatus === STATUS.CANCELLED)
          ab =
            '<span class="px-2 py-0.5 rounded text-xs font-bold text-slate-700">Cancelled</span>';
        else if (log.previousStatus === STATUS.COMPLETED)
          ab =
            '<span class="px-2 py-0.5 rounded text-xs font-bold text-slate-700">Credited</span>';
        else if (log.previousStatus === STATUS.REJECTED)
          ab =
            '<span class="px-2 py-0.5 rounded text-xs font-bold text-slate-700">Rejected</span>';
        else
          ab =
            '<span class="px-2 py-0.5 rounded text-xs font-bold text-slate-700">Unknown</span>';
        const ts = log.timestamp?.toDate
          ? log.timestamp.toDate()
          : new Date(log.timestamp || Date.now());
        const fd = ts.toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
        const ft = ts.toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        });
        const td = log.trashedAt
          ? formatFirebaseTimestamp(log.trashedAt)
          : "N/A";
        tr += `<tr class="border-b bg-red-50/30 hover:bg-red-100/50"><td class="px-4 py-3"><div class="font-bold">${log.residentName || "N/A"}</div><div class="text-[10px] text-red-500"><i class="fa-solid fa-trash-can mr-1"></i>Deleted: ${td}</div><div class="text-[10px] text-stone-400">By: ${log.trashedBy || "Admin"}</div></td><td class="px-4 py-3 font-medium">${log.eventTitle || "N/A"}</td><td class="px-4 py-3"><div class="text-xs">${fd}</div><div class="text-xs text-stone-400">${ft}</div></td><td class="px-4 py-3"><span class="text-xs px-2 py-1 rounded-full bg-red-100 text-red-700 font-bold"><i class="fa-solid fa-trash-can text-[10px]"></i> Trashed</span></td><td class="px-4 py-3"><div class="flex gap-1.5"><button onclick="event.stopPropagation();restoreActivityLog('${id}')" class="text-xs px-3 py-2 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 font-medium"><i class="fa-solid fa-rotate-left"></i> Restore</button><button onclick="event.stopPropagation();permanentlyDeleteActivityLog('${id}')" class="text-xs px-3 py-2 rounded-lg bg-red-500 text-white hover:bg-red-600 font-medium"><i class="fa-solid fa-trash"></i> Delete</button></div></td></tr>`;
      });
    }
    modal.innerHTML = `<div class="bg-white rounded-2xl w-full max-w-6xl max-h-[90vh] shadow-2xl border border-gray-200 modal-enter flex flex-col" style="margin:auto"><div class="p-6 border-b flex items-center justify-between shrink-0 bg-white rounded-t-2xl"><div><h2 class="text-xl font-extrabold text-red-700"><i class="fa-solid fa-trash-can"></i> Trash - Deleted Activity Logs</h2><p class="text-sm text-stone-500">${tl.length || 0} log(s) in trash</p></div><div class="flex items-center gap-3">${tl.length > 0 ? `<button onclick="emptyAllTrash()" class="text-xs px-4 py-2 rounded-lg bg-red-500 text-white hover:bg-red-600 font-semibold"><i class="fa-solid fa-trash-can"></i> Empty Trash</button><button onclick="restoreAllTrash()" class="text-xs px-4 py-2 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 font-semibold"><i class="fa-solid fa-rotate-left"></i> Restore All</button>` : ""}<button onclick="document.getElementById('trash-logs-modal').remove()" class="text-gray-400 hover:text-gray-600 p-2"><i class="fa-solid fa-xmark text-xl"></i></button></div></div><div class="overflow-y-auto flex-1" style="min-height:0"><table class="w-full text-sm"><thead class="sticky top-0 z-10"><tr class="bg-red-50 text-xs font-semibold text-red-700 uppercase"><th class="px-4 py-3 text-left bg-red-50">Resident Name</th><th class="px-4 py-3 text-left bg-red-50">Event</th><th class="px-4 py-3 text-left bg-red-50">Date & Time</th><th class="px-4 py-3 text-left bg-red-50">Status</th><th class="px-4 py-3 text-left bg-red-50">Actions</th></tr></thead><tbody class="divide-y divide-gray-100">${tr}</tbody></table></div><div class="p-4 border-t bg-gray-50 shrink-0 rounded-b-2xl"><p class="text-xs text-stone-400 text-center"><i class="fa-solid fa-info-circle mr-1"></i>Trashed logs can be restored.</p></div></div>`;
    document.body.appendChild(modal);
    window.hideLoading();
  } catch (err) {
    window.hideLoading();
    window.showAdminAlert("Error", "Failed: " + err.message, false);
  }
};
window.restoreActivityLog = function (id) {
  window.showConfirmPopup("Restore Log", "Restore this log?", async () => {
    window.showLoading();
    try {
      const d = await getDoc(doc(db, "participants", id));
      if (!d.exists()) {
        window.hideLoading();
        window.showAdminAlert("Error", "Not found.", false);
        return;
      }
      await updateDoc(doc(db, "participants", id), {
        status: d.data().previousStatus || STATUS.REGISTERED,
        restoredAt: serverTimestamp(),
        restoredBy: getAdminDisplayName(),
        restoredById: loggedInAdmin?.id || "system",
        trashedAt: null,
        trashedBy: null,
        trashedById: null,
        previousStatus: null,
      });
      const m = document.getElementById("trash-logs-modal");
      if (m) m.remove();
      window.showAdminAlert("Log Restored", "Restored.", true);
    } catch (err) {
      window.hideLoading();
      window.showAdminAlert("Error", "Failed: " + err.message, false);
    } finally {
      window.hideLoading();
    }
  });
};
window.permanentlyDeleteActivityLog = function (id) {
  window.showConfirmPopup(
    "Permanently Delete",
    "Cannot be undone.",
    async () => {
      window.showLoading();
      try {
        await deleteDoc(doc(db, "participants", id));
        const m = document.getElementById("trash-logs-modal");
        if (m) m.remove();
        window.showAdminAlert("Log Deleted", "Permanently deleted.", true);
      } catch (err) {
        window.hideLoading();
        window.showAdminAlert("Error", "Failed: " + err.message, false);
      } finally {
        window.hideLoading();
      }
    },
  );
};
window.emptyAllTrash = function () {
  window.showConfirmPopup(
    "Empty All Trash",
    "Delete ALL trashed logs?",
    async () => {
      window.showLoading();
      try {
        const s = await getDocs(
          query(
            collection(db, "participants"),
            where("status", "==", STATUS.TRASHED),
          ),
        );
        if (s.empty) {
          window.hideLoading();
          window.showAdminAlert("Trash Empty", "No logs.", false);
          return;
        }
        const b = writeBatch(db);
        let c = 0;
        s.forEach((d) => {
          b.delete(d.ref);
          c++;
        });
        await b.commit();
        const m = document.getElementById("trash-logs-modal");
        if (m) m.remove();
        window.showAdminAlert("Trash Emptied", `${c} log(s) deleted.`, true);
      } catch (err) {
        window.hideLoading();
        window.showAdminAlert("Error", "Failed: " + err.message, false);
      } finally {
        window.hideLoading();
      }
    },
  );
};
window.restoreAllTrash = function () {
  window.showConfirmPopup(
    "Restore All Trash",
    "Restore ALL trashed logs?",
    async () => {
      window.showLoading();
      try {
        const s = await getDocs(
          query(
            collection(db, "participants"),
            where("status", "==", STATUS.TRASHED),
          ),
        );
        if (s.empty) {
          window.hideLoading();
          window.showAdminAlert("Trash Empty", "No logs.", false);
          return;
        }
        const b = writeBatch(db);
        let c = 0;
        s.forEach((d) => {
          const data = d.data();
          b.update(d.ref, {
            status: data.previousStatus || STATUS.REGISTERED,
            restoredAt: serverTimestamp(),
            restoredBy: getAdminDisplayName(),
            restoredById: loggedInAdmin?.id || "system",
            trashedAt: null,
            trashedBy: null,
            trashedById: null,
            previousStatus: null,
          });
          c++;
        });
        await b.commit();
        const m = document.getElementById("trash-logs-modal");
        if (m) m.remove();
        window.showAdminAlert("All Restored", `${c} log(s) restored.`, true);
      } catch (err) {
        window.hideLoading();
        window.showAdminAlert("Error", "Failed: " + err.message, false);
      } finally {
        window.hideLoading();
      }
    },
  );
};
window.printActivityLogs = function () {
  // FIXED: Service Hours print now uses Validated Service Ledger with requested columns:
  // Resident Name | Event | Credited Hours | Date & Time | Status
  const hoursTbody = document.getElementById("admin-hours-tbody");
  const logsTbody = document.getElementById("activity-logs-tbody");
  let source = null;
  let rows = [];
  if (hoursTbody) {
    const allRows = hoursTbody.querySelectorAll("tr");
    const filtered = Array.from(allRows).filter((r) => {
      if (r.style.display === "none") return false;
      const cells = r.querySelectorAll("td");
      if (cells.length === 1 && cells[0].hasAttribute("colspan")) return false;
      return cells.length >= 4;
    });
    if (filtered.length > 0) {
      source = "hours";
      rows = filtered;
    }
  }
  if (source !== "hours" && logsTbody) {
    const logRows = logsTbody.querySelectorAll("tr.activity-log-row");
    const filtered = Array.from(logRows).filter((r) => r.style.display !== "none");
    if (filtered.length > 0) {
      source = "logs";
      rows = filtered;
    }
  }
  if (!source || rows.length === 0) {
    window.showAdminAlert("No Data", "No service hours to print.", false);
    return;
  }
  const n = new Date();
  const ds = n.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const ts = n.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  let filterLabel = "All Records";
  if (source === "logs") {
    const cf = document.getElementById("activity-filter-select")?.value || "all";
    const map = { all: "All Activities", Registered: "Registered Activities", Completed: "Credited Activities", Cancelled: "Cancelled Activities", Rejected: "Rejected Activities" };
    filterLabel = map[cf] || "All Activities";
  } else {
    filterLabel = "Validated Service Hours";
  }
  const pw = window.open("", "_blank");
  if (!pw) {
    window.showAdminAlert("Popup Blocked", "Please allow popups to print.", false);
    return;
  }
  let bodyRows = "";
  if (source === "hours") {
    bodyRows = rows.map((r) => {
      const c = r.querySelectorAll("td");
      const residentName = (c[0]?.textContent || "").replace(/\s*NEW\s*$/, "").trim() || "";
      const eventTitle = c[1]?.textContent.trim() || "";
      const creditedHours = c[2]?.textContent.trim() || "";
      const status = c[3]?.textContent.trim() || "";
      const certCell = c[4];
      let dateTime = "";
      if (certCell) {
        const divs = certCell.querySelectorAll("div");
        if (divs.length >= 2) dateTime = divs[1].textContent.trim();
        else if (divs.length === 1) dateTime = divs[0].textContent.trim();
        else dateTime = certCell.textContent.trim().split("\n").pop().trim();
      }
      if (!dateTime) dateTime = certCell?.textContent.trim() || "N/A";
      // Escape HTML to avoid injection
      const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<tr><td>${esc(residentName)}</td><td>${esc(eventTitle)}</td><td style="font-weight:800;text-align:center">${esc(creditedHours)}</td><td>${esc(dateTime)}</td><td>${esc(status)}</td></tr>`;
    }).join("");
  } else {
    bodyRows = rows.map((r) => {
      const c = r.querySelectorAll("td");
      if (c.length >= 3) {
        const residentName = (c[0]?.textContent || "").replace(/\s*NEW\s*$/, "").trim() || "";
        const eventTitle = c[1]?.textContent.trim() || "";
        const dateTime = (c[2]?.textContent || "").replace(/\s+/g, " ").trim() || "";
        const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return `<tr><td>${esc(residentName)}</td><td>${esc(eventTitle)}</td><td>${esc(dateTime)}</td></tr>`;
      }
      return "";
    }).join("");
  }
  const title = source === "hours" ? "Service Hours Report" : "Activity Logs Report";
  const tableHead =
    source === "hours"
      ? "<thead><tr><th>Resident Name</th><th>Event</th><th style=\"text-align:center\">Credited Hours</th><th>Date &amp; Time</th><th>Status</th></tr></thead>"
      : "<thead><tr><th>Resident Name</th><th>Event</th><th>Date &amp; Time</th></tr></thead>";
  pw.document.write(
    `<!DOCTYPE html><html><head><title>${title}</title><style>
      body{font-family:Arial,Helvetica,sans-serif;padding:24px;color:#1e293b}
      .header{text-align:center;margin-bottom:28px;border-bottom:3px solid #003B71;padding-bottom:18px}
      .header h1{color:#003B71;margin:0;font-size:22px;font-weight:900;letter-spacing:-.02em}
      .header p{color:#64748b;margin:6px 0;font-size:13px}
      .header .badge{display:inline-block;margin-top:8px;padding:6px 12px;background:#f1f5f9;border-radius:999px;font-size:11px;font-weight:800;color:#003B71}
      table{width:100%;border-collapse:collapse;margin-top:18px;font-size:12px}
      th{background:#003B71;color:#fff;padding:12px 10px;text-align:left;font-size:11px;letter-spacing:.04em;text-transform:uppercase}
      td{padding:10px 10px;border-bottom:1px solid #e2e8f0;font-size:12.5px;vertical-align:top}
      tr:nth-child(even){background:#f8fafc}
      .footer{margin-top:28px;text-align:center;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:14px}
      @media print{body{padding:0} .no-print{display:none}}
    </style></head><body>
      <div class="header">
        <h1>Municipality of Victoria</h1>
        <p>${title}</p>
        <p>${filterLabel} &nbsp;|&nbsp; ${ds} at ${ts}</p>
        <p>Generated by: ${getAdminDisplayName()}</p>
        <span class="badge">${rows.length} record(s)</span>
      </div>
      <table>
        ${tableHead}
        <tbody>${bodyRows}</tbody>
      </table>
      <div class="footer">
        <p>Official ${source === "hours" ? "Service Hours" : "Activity Log"} Report — Victoria Civic Portal</p>
        <p>Generated: ${ds} at ${ts} &nbsp;|&nbsp; For official use only</p>
      </div>
      <script>window.onload=function(){setTimeout(function(){window.print()},400)}<\/script>
    </body></html>`,
  );
  pw.document.close();
};
window.printServiceHours = window.printActivityLogs;


// ========================================== DONATION FUNCTIONS ==========================================
window.filterDonations = function (filter) {
  const d = document.getElementById("donation-filter-select");
  if (filter && d && d.value !== filter) d.value = filter;
  const selectedStatus = (d?.value || "all").toLowerCase();
  const searchInput = document.getElementById("donation-search-input");
  const query = (searchInput?.value || "").trim().toLowerCase();

  let visible = 0;
  document.querySelectorAll(".donation-row").forEach((r) => {
    const rs = (r.getAttribute("data-status") || "").toLowerCase();
    const rowText = r.textContent.toLowerCase();

    let matchesStatus = false;
    if (selectedStatus === "all") matchesStatus = true;
    else if (selectedStatus === "confirmed")
      matchesStatus =
        rs === STATUS.APPROVED.toLowerCase() ||
        rs === STATUS.CONFIRMED.toLowerCase();
    else matchesStatus = rs === selectedStatus;

    const matchesQuery = !query || rowText.includes(query);

    const show = matchesStatus && matchesQuery;
    r.style.display = show ? "" : "none";
    if (show) visible++;
  });

  const rc = document.getElementById("donation-result-count");
  if (rc) {
    rc.textContent = `${visible} ${visible === 1 ? "record" : "records"}`;
  }
};
window.sortDonations = function (value) {
  const [f, d] = value.split("-");
  donationSortField = f;
  donationSortDirection = d;
  const sd = document.getElementById("donation-sort-select");
  if (sd) sd.value = value;
  renderSortedDonations();
  window.filterDonations();
};

// RECOMMENDATION: Donation data shouldn't be deleted to avoid negligence & misuse.
window.clearDonations = function () {
  window.showAdminAlert(
    "Action Protected",
    "Donation records are protected for municipal financial accountability and cannot be bulk deleted to avoid negligence and misuse.",
    false,
  );
};

window.deleteDonationRecord = function (id, donorName = "Donor") {
  window.showConfirmPopup(
    "Delete Donation Record?",
    `Are you sure you want to delete the donation record for "${donorName}"? This will delete this specific donation entry.`,
    async () => {
      window.showLoading();
      try {
        await deleteDoc(doc(db, "donations", id));
        if (typeof closeDonationScreenshotModal === "function") {
          closeDonationScreenshotModal();
        }
        window.showAdminAlert("Donation Deleted", "Specific donation record removed.", true);
      } catch (err) {
        window.showAdminAlert("Error", err.message, false);
      } finally {
        window.hideLoading();
      }
    },
  );
};

function isEligibleRefundPaymentMethod(method) {
  if (!method) return false;
  const m = String(method).toLowerCase().replace(/[-_\s/]/g, "");
  return (
    m === "gcash" ||
    m === "maya" ||
    m === "paymaya" ||
    m.includes("bank")
  );
}

function getDonationDate(donation) {
  if (!donation) return null;
  const val = donation.createdAt || donation.timestamp || donation.date;
  if (!val) return null;
  if (val.toDate && typeof val.toDate === "function") return val.toDate();
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function calculateWorkingDays(startDate, endDate = new Date()) {
  if (!startDate) return Infinity;
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return Infinity;
  if (end < start) return 0;

  let cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const target = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  let count = 0;

  while (cur < target) {
    cur.setDate(cur.getDate() + 1);
    const day = cur.getDay(); // 0 = Sun, 6 = Sat
    if (day !== 0 && day !== 6) {
      count++;
    }
  }
  return count;
}

function isEligibleForRefund(donation) {
  if (!donation) return false;
  const eff = effectiveStatus(donation);
  if (eff === STATUS.REFUNDED) return false;
  if (eff === STATUS.REJECTED) return false;

  const method = donation.paymentMethod || "";
  if (!isEligibleRefundPaymentMethod(method)) return false;

  const donationDate = getDonationDate(donation);
  if (!donationDate) return false;

  const workingDays = calculateWorkingDays(donationDate, new Date());
  return workingDays <= 3;
}

window.refundDonationRecord = function (id, donorName = "Donor", amt = "", method = "") {
  window.showConfirmPopup(
    "Process Donation Refund?",
    `Are you sure you want to process a refund for "${donorName}" (${amt ? amt + " " : ""}via ${method || "Electronic Payment"})? This payment occurred within 3 working days and will be marked as Refunded.`,
    async () => {
      window.showLoading();
      try {
        const donationRef = doc(db, "donations", id);
        const snap = await getDoc(donationRef);
        const d = snap.exists() ? snap.data() : null;

        await updateDoc(donationRef, {
          status: STATUS.REFUNDED,
          paymentStatus: "Refunded",
          refundedAt: serverTimestamp(),
          refundedBy: getAdminDisplayName(),
          refundedById: loggedInAdmin?.id || "system",
        });

        const recipientId = d?.donorId || d?.userId || d?.residentId;
        if (recipientId) {
          try {
            await createNotification(
              recipientId,
              "Donation Refunded",
              `Your donation of ${d?.amount ? "₱" + parseFloat(d.amount).toLocaleString() : "items"} via ${formatPaymentMethodName(d?.paymentMethod || method)} has been marked as Refunded by ${getAdminDisplayName()}.`,
              "donation_refund"
            );
          } catch (notifErr) {
            console.warn("Could not dispatch refund notification:", notifErr);
          }
        }

        if (typeof closeDonationScreenshotModal === "function") {
          closeDonationScreenshotModal();
        }
        window.showAdminAlert("Refund Processed", `Donation for "${donorName}" has been successfully marked as Refunded.`, true);
      } catch (err) {
        window.showAdminAlert("Error", err.message || "Failed to process refund.", false);
      } finally {
        window.hideLoading();
      }
    },
  );
};

window.viewDonationTrash = async function () {
  window.showLoading();
  try {
    const s = await getDocs(
      query(collection(db, "donations"), where("status", "==", STATUS.TRASHED)),
    );
    const td = [];
    s.forEach((d) => {
      td.push({ id: d.id, ...d.data() });
    });
    td.sort((a, b) => {
      const dA = a.trashedAt?.toDate
        ? a.trashedAt.toDate()
        : new Date(a.trashedAt || 0);
      const dB = b.trashedAt?.toDate
        ? b.trashedAt.toDate()
        : new Date(b.trashedAt || 0);
      return dB - dA;
    });
    const em = document.getElementById("donation-trash-modal");
    if (em) em.remove();
    const modal = document.createElement("div");
    modal.className =
      "fixed inset-0 bg-gray-900/80 backdrop-blur-sm flex items-center justify-center p-4 z-[180] overflow-hidden";
    modal.id = "donation-trash-modal";
    modal.addEventListener("click", function (e) {
      if (e.target === modal) modal.remove();
    });
    let tr = "";
    if (td.length === 0) {
      tr = `<tr><td colspan="7" class="px-4 py-10 text-center text-gray-400"><i class="fa-solid fa-trash-can text-4xl mb-3 block text-gray-300"></i><p class="text-lg font-bold text-gray-500">Trash is Empty</p></td></tr>`;
    } else {
      td.forEach((don) => {
        const id = don.id;
        const amt = don.amount
          ? `P${parseFloat(don.amount).toLocaleString()}`
          : don.item || "N/A";
        const tdd = don.trashedAt
          ? formatFirebaseTimestamp(don.trashedAt)
          : "N/A";
        const cd = don.createdAt
          ? formatFirebaseTimestamp(don.createdAt)
          : "N/A";
        let psb = "";
        if (
          don.previousStatus === STATUS.APPROVED ||
          don.previousStatus === STATUS.CONFIRMED
        )
          psb =
            '<span class="badge-success px-2 py-0.5 rounded text-xs font-bold">Confirmed</span>';
        else if (don.previousStatus === STATUS.REJECTED)
          psb =
            '<span class="badge-danger px-2 py-0.5 rounded text-xs font-bold">Rejected</span>';
        else
          psb =
            '<span class="badge-warning px-2 py-0.5 rounded text-xs font-bold">Pending</span>';
        tr += `<tr class="border-b bg-red-50/30 hover:bg-red-100/50"><td class="px-4 py-3"><div class="font-bold">${don.donorName || "Anonymous"}</div><div class="text-[10px] text-red-500"><i class="fa-solid fa-trash-can mr-1"></i>Deleted: ${tdd}</div><div class="text-[10px] text-stone-400">By: ${don.trashedBy || "Admin"}</div></td><td class="px-4 py-3 font-bold text-emerald-800">${amt}</td><td class="px-4 py-3 text-sm">${don.purpose || "N/A"}</td><td class="px-4 py-3 text-xs text-stone-500">${cd}</td><td class="px-4 py-3">${psb}</td><td class="px-4 py-3"><span class="text-xs px-2 py-1 rounded-full bg-red-100 text-red-700 font-bold"><i class="fa-solid fa-trash-can text-[10px]"></i> Trashed</span></td><td class="px-4 py-3"><div class="flex gap-1.5"><button onclick="event.stopPropagation();restoreDonation('${id}')" class="text-xs px-3 py-2 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 font-medium"><i class="fa-solid fa-rotate-left"></i> Restore</button><button onclick="event.stopPropagation();permanentlyDeleteDonation('${id}')" class="text-xs px-3 py-2 rounded-lg bg-red-500 text-white hover:bg-red-600 font-medium"><i class="fa-solid fa-trash"></i> Delete</button></div></td></tr>`;
      });
    }
    modal.innerHTML = `<div class="bg-white rounded-2xl w-full max-w-6xl max-h-[90vh] shadow-2xl border border-gray-200 modal-enter flex flex-col" style="margin:auto"><div class="p-6 border-b flex items-center justify-between shrink-0 bg-white rounded-t-2xl"><div><h2 class="text-xl font-extrabold text-red-700"><i class="fa-solid fa-trash-can"></i> Trash - Deleted Donations</h2><p class="text-sm text-stone-500">${td.length || 0} donation(s) in trash</p></div><div class="flex items-center gap-3">${td.length > 0 ? `<button onclick="emptyDonationTrash()" class="text-xs px-4 py-2 rounded-lg bg-red-500 text-white hover:bg-red-600 font-semibold"><i class="fa-solid fa-trash-can"></i> Empty Trash</button><button onclick="restoreAllDonations()" class="text-xs px-4 py-2 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 font-semibold"><i class="fa-solid fa-rotate-left"></i> Restore All</button>` : ""}<button onclick="document.getElementById('donation-trash-modal').remove()" class="text-gray-400 hover:text-gray-600 p-2"><i class="fa-solid fa-xmark text-xl"></i></button></div></div><div class="overflow-y-auto flex-1" style="min-height:0"><table class="w-full text-sm"><thead class="sticky top-0 z-10"><tr class="bg-red-50 text-xs font-semibold text-red-700 uppercase"><th class="px-4 py-3 text-left bg-red-50">Donor Name</th><th class="px-4 py-3 text-left bg-red-50">Resource</th><th class="px-4 py-3 text-left bg-red-50">Purpose</th><th class="px-4 py-3 text-left bg-red-50">Date</th><th class="px-4 py-3 text-left bg-red-50">Prev Status</th><th class="px-4 py-3 text-left bg-red-50">Status</th><th class="px-4 py-3 text-left bg-red-50">Actions</th></tr></thead><tbody class="divide-y divide-gray-100">${tr}</tbody></table></div><div class="p-4 border-t bg-gray-50 shrink-0 rounded-b-2xl"><p class="text-xs text-stone-400 text-center"><i class="fa-solid fa-info-circle mr-1"></i>Trashed donations can be restored.</p></div></div>`;
    document.body.appendChild(modal);
    window.hideLoading();
  } catch (err) {
    window.hideLoading();
    window.showAdminAlert("Error", "Failed: " + err.message, false);
  }
};
window.restoreDonation = function (id) {
  window.showConfirmPopup("Restore Donation", "Restore?", async () => {
    window.showLoading();
    try {
      const d = await getDoc(doc(db, "donations", id));
      if (!d.exists()) {
        window.hideLoading();
        window.showAdminAlert("Error", "Not found.", false);
        return;
      }
      await updateDoc(doc(db, "donations", id), {
        status: d.data().previousStatus || STATUS.PENDING,
        restoredAt: serverTimestamp(),
        restoredBy: getAdminDisplayName(),
        restoredById: loggedInAdmin?.id || "system",
        trashedAt: null,
        trashedBy: null,
        trashedById: null,
        previousStatus: null,
      });
      const m = document.getElementById("donation-trash-modal");
      if (m) m.remove();
      window.showAdminAlert("Donation Restored", "Restored.", true);
    } catch (err) {
      window.hideLoading();
      window.showAdminAlert("Error", "Failed: " + err.message, false);
    } finally {
      window.hideLoading();
    }
  });
};
window.permanentlyDeleteDonation = function (id) {
  window.showConfirmPopup(
    "Permanently Delete",
    "Cannot be undone.",
    async () => {
      window.showLoading();
      try {
        await deleteDoc(doc(db, "donations", id));
        const m = document.getElementById("donation-trash-modal");
        if (m) m.remove();
        window.showAdminAlert("Donation Deleted", "Permanently deleted.", true);
      } catch (err) {
        window.hideLoading();
        window.showAdminAlert("Error", "Failed: " + err.message, false);
      } finally {
        window.hideLoading();
      }
    },
  );
};
window.emptyDonationTrash = function () {
  window.showConfirmPopup(
    "Empty Donation Trash",
    "Delete ALL trashed?",
    async () => {
      window.showLoading();
      try {
        const s = await getDocs(
          query(
            collection(db, "donations"),
            where("status", "==", STATUS.TRASHED),
          ),
        );
        if (s.empty) {
          window.hideLoading();
          window.showAdminAlert("Trash Empty", "No donations.", false);
          return;
        }
        const b = writeBatch(db);
        let c = 0;
        s.forEach((d) => {
          b.delete(d.ref);
          c++;
        });
        await b.commit();
        const m = document.getElementById("donation-trash-modal");
        if (m) m.remove();
        window.showAdminAlert("Trash Emptied", `${c} deleted.`, true);
      } catch (err) {
        window.hideLoading();
        window.showAdminAlert("Error", "Failed: " + err.message, false);
      } finally {
        window.hideLoading();
      }
    },
  );
};
window.restoreAllDonations = function () {
  window.showConfirmPopup("Restore All Donations", "Restore ALL?", async () => {
    window.showLoading();
    try {
      const s = await getDocs(
        query(
          collection(db, "donations"),
          where("status", "==", STATUS.TRASHED),
        ),
      );
      if (s.empty) {
        window.hideLoading();
        window.showAdminAlert("Trash Empty", "No donations.", false);
        return;
      }
      const b = writeBatch(db);
      let c = 0;
      s.forEach((d) => {
        const data = d.data();
        b.update(d.ref, {
          status: data.previousStatus || STATUS.PENDING,
          restoredAt: serverTimestamp(),
          restoredBy: getAdminDisplayName(),
          restoredById: loggedInAdmin?.id || "system",
          trashedAt: null,
          trashedBy: null,
          trashedById: null,
          previousStatus: null,
        });
        c++;
      });
      await b.commit();
      const m = document.getElementById("donation-trash-modal");
      if (m) m.remove();
      window.showAdminAlert("All Restored", `${c} restored.`, true);
    } catch (err) {
      window.hideLoading();
      window.showAdminAlert("Error", "Failed: " + err.message, false);
    } finally {
      window.hideLoading();
    }
  });
};
window.printDonations = function () {
  const tbody = document.getElementById("admin-donations-tbody");
  if (!tbody) return;
  const rows = tbody.querySelectorAll("tr.donation-row");
  const vr = Array.from(rows).filter((r) => r.style.display !== "none");
  if (vr.length === 0) {
    window.showAdminAlert("No Data", "No donations to print.", false);
    return;
  }
  const cf = document.getElementById("donation-filter-select")?.value || "all";
  const fl = {
    all: "All Donations",
    Confirmed: "Confirmed Donations",
    Pending: "Pending Donations",
    Rejected: "Rejected Donations",
  };
  const n = new Date();
  const ds = n.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const ts = n.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const pw = window.open("", "_blank");
  pw.document.write(
    `<!DOCTYPE html><html><head><title>Donations Report</title><style>body{font-family:Arial;padding:20px;color:#333}.header{text-align:center;margin-bottom:30px;border-bottom:2px solid #003B71;padding-bottom:20px}.header h1{color:#003B71;margin:0;font-size:24px}.header p{color:#666;margin:5px 0;font-size:14px}table{width:100%;border-collapse:collapse;margin-top:20px}th{background-color:#003B71;color:white;padding:12px;text-align:left;font-size:12px}td{padding:10px 12px;border-bottom:1px solid #ddd;font-size:13px}tr:nth-child(even){background-color:#f9f9f9}.footer{margin-top:30px;text-align:center;font-size:12px;color:#999}@media print{body{padding:0}}</style></head><body><div class="header"><h1>Municipality of Victoria</h1><p>Donations Report</p><p>${fl[cf] || "All Donations"} | ${ds} at ${ts}</p><p>Generated by: ${getAdminDisplayName()}</p></div><table><thead><tr><th>Donor Name</th><th>Resource</th><th>Purpose</th><th>Date</th><th>Status</th></tr></thead><tbody>${vr
      .map((r) => {
        const c = r.querySelectorAll("td");
        if (c.length >= 6)
          return `<tr><td>${c[0]?.textContent.trim() || ""}</td><td>${c[1]?.textContent.trim() || ""}</td><td>${c[3]?.textContent.trim() || ""}</td><td>${c[4]?.textContent.trim() || ""}</td><td>${c[5]?.textContent.trim() || ""}</td></tr>`;
        if (c.length >= 5)
          return `<tr><td>${c[0]?.textContent.trim() || ""}</td><td>${c[1]?.textContent.trim() || ""}</td><td>${c[2]?.textContent.trim() || ""}</td><td>${c[3]?.textContent.trim() || ""}</td><td>${c[4]?.textContent.trim() || ""}</td></tr>`;
        return "";
      })
      .join(
        "",
      )}</tbody></table><div class="footer"><p>Official Donations Report</p><p>Generated: ${ds} at ${ts}</p></div></body></html>`,
  );
  pw.document.close();
  setTimeout(() => pw.print(), 500);
};
function initDonationsListener() {
  const tbody = document.getElementById("admin-donations-tbody");
  if (!tbody) return;
  const dropdown = document.getElementById("donation-filter-select");
  if (dropdown) dropdown.value = "all";
  const sortDropdown = document.getElementById("donation-sort-select");
  if (sortDropdown) sortDropdown.value = "date-desc";
  onSnapshot(
    query(collection(db, "donations"), where("status", "!=", STATUS.TRASHED)),
    (snapshot) => {
      if (snapshot.empty) {
        tbody.innerHTML =
          '<tr><td colspan="7" class="px-4 py-6 text-center text-stone-400">No donations reported yet.</td></tr>';
        allDonations = [];
        const rc0 = document.getElementById("donation-result-count");
        if (rc0) rc0.textContent = "0 records";
        refreshActionBadges();
        return;
      }
      allDonations = [];
      snapshot.forEach((d) => {
        allDonations.push({ id: d.id, ...d.data() });
      });
      renderSortedDonations();
      refreshActionBadges();
      const cf = dropdown?.value || "all";
      window.filterDonations(cf);
    },
  );
}
function renderSortedDonations() {
  const tbody = document.getElementById("admin-donations-tbody");
  if (!tbody) return;
  const sd = [...allDonations].sort((a, b) => {
    if (donationSortField === "name") {
      const nA = (a.donorName || "").toLowerCase(),
        nB = (b.donorName || "").toLowerCase();
      return donationSortDirection === "asc"
        ? nA.localeCompare(nB)
        : nB.localeCompare(nA);
    } else {
      const dA = a.createdAt?.toDate
        ? a.createdAt.toDate()
        : new Date(a.createdAt || 0),
        dB = b.createdAt?.toDate
          ? b.createdAt.toDate()
          : new Date(b.createdAt || 0);
      return donationSortDirection === "asc" ? dA - dB : dB - dA;
    }
  });
  if (sd.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="7" class="px-4 py-6 text-center text-stone-400">No donations reported yet.</td></tr>';
    const rc0 = document.getElementById("donation-result-count");
    if (rc0) rc0.textContent = "0 records";
    return;
  }
  let html = "";
  sd.forEach((d) => {
    const id = d.id;
    // REJECTION FIX: judge the record by its EFFECTIVE status (honors
    // paymentStatus fallbacks and legacy wording) so no donation shows in
    // the wrong bucket.
    const effStatus = effectiveStatus(d);
    let sb = "";
    if (effStatus === STATUS.APPROVED)
      sb =
        '<span class="badge-success px-2 py-0.5 rounded text-xs font-bold">Confirmed</span>';
    else if (effStatus === STATUS.REJECTED)
      sb =
        '<span class="badge-danger px-2 py-0.5 rounded text-xs font-bold">Rejected</span>';
    else if (effStatus === STATUS.REFUNDED)
      sb =
        '<span class="px-2 py-0.5 rounded text-xs font-bold bg-amber-100 text-amber-900 border border-amber-300">Refunded</span>';
    else
      sb =
        '<span class="badge-warning px-2 py-0.5 rounded text-xs font-bold">Pending</span>';
    // Categorized item donations: show category + quantity + description.
    const itemDetails = formatItemDonationDetails(d);
    const amt = d.amount
      ? `P${parseFloat(d.amount).toLocaleString()}`
      : itemDetails || d.item || "N/A";
    const cd = d.createdAt ? formatFirebaseTimestamp(d.createdAt) : "N/A";
    const screenshotUrl =
      typeof safeImageUrl === "function"
        ? safeImageUrl(
          d.paymentScreenshot || d.screenshot || d.proofOfPayment || "",
        )
        : d.paymentScreenshot || d.screenshot || d.proofOfPayment || "";
    const methodText =
      typeof formatPaymentMethodName === "function"
        ? formatPaymentMethodName(
          d.paymentMethod ||
          (screenshotUrl ? "E-Wallet / Bank" : "Cash / Item"),
        )
        : d.paymentMethod || "E-Wallet";
    let proofCell = "";
    if (screenshotUrl) {
      proofCell = `<div class="flex items-center gap-2.5">
        <div class="w-11 h-11 rounded-xl overflow-hidden border border-slate-200 bg-slate-100 shrink-0 cursor-pointer shadow-sm hover:ring-2 hover:ring-victoria-blue transition-all" onclick="openDonationScreenshotModal('${id}')">
          <img src="${screenshotUrl}" alt="Receipt" class="w-full h-full object-cover">
        </div>
        <div>
          <button type="button" onclick="openDonationScreenshotModal('${id}')" class="text-xs font-bold text-victoria-blue hover:underline flex items-center gap-1">
            <i class="fa-solid fa-file-invoice-dollar text-victoria-gold"></i> View Receipt
          </button>
          <p class="text-[10px] text-slate-500 font-medium uppercase tracking-wide mt-0.5">${methodText}</p>
        </div>
      </div>`;
    } else {
      const isCash =
        String(d.paymentMethod || "").toLowerCase() === "cash" ||
        String(d.paymentMethod || "").toLowerCase() === "cash payment";
      proofCell = `<span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium ${isCash ? "bg-amber-50 text-amber-800 border border-amber-200" : "bg-slate-100 text-slate-600 border border-slate-200"}">
        <i class="fa-solid ${isCash ? "fa-money-bill-wave text-amber-600" : "fa-box text-slate-400"}"></i> ${methodText}
      </span>`;
    }
    const isNew = effStatus === STATUS.PENDING;
    const escId = (id || "").replace(/'/g, "\\'");
    const escDonor = (d.donorName || "Anonymous").replace(/'/g, "\\'");
    const escAmt = (amt || "").replace(/'/g, "\\'");
    const escMethod = (d.paymentMethod || "").replace(/'/g, "\\'");
    const canRefund = isEligibleForRefund(d);
    let refundBtn = "";
    if (canRefund) {
      refundBtn = `<button type="button" onclick="refundDonationRecord('${escId}', '${escDonor}', '${escAmt}', '${escMethod}')" class="px-2 py-1 rounded text-xs font-bold bg-amber-100 text-amber-900 hover:bg-amber-200 transition-all inline-flex items-center gap-1 shadow-xs mr-1.5" title="Refund within 3 working days"><i class="fa-solid fa-rotate-left text-[10px]"></i><span>Refund</span></button>`;
    }
    html += `<tr class="${isNew ? "row-new " : ""}hover:bg-blue-50/60 cursor-pointer border-b table-row donation-row transition-colors" data-status="${effStatus}" onclick="openDonationScreenshotModal('${id}')"><td class="px-5 py-4 font-bold">${d.donorName || "Anonymous"}${isNew ? " " + newChipHtml() : ""}</td><td class="px-5 py-4 font-bold text-emerald-800">${amt}</td><td class="px-5 py-4" onclick="event.stopPropagation(); openDonationScreenshotModal('${id}');">${proofCell}</td><td class="px-5 py-4 text-sm">${d.purpose || "N/A"}</td><td class="px-5 py-4 text-xs text-stone-500">${cd}</td><td class="px-5 py-4">${sb}</td><td class="px-4 py-4 text-right" onclick="event.stopPropagation()">${refundBtn}<button type="button" onclick="deleteDonationRecord('${escId}', '${escDonor}')" class="w-8 h-8 rounded text-slate-400 hover:bg-rose-50 hover:text-rose-600 transition-all inline-flex items-center justify-center" title="Delete specific donation record"><i class="fa-solid fa-trash-can text-xs"></i></button></td></tr>`;
  });
  tbody.innerHTML = html;
  window.filterDonations();
}

// ========================================== VOLUNTEER FUNCTIONS ==========================================
window.filterVolunteers = function (filter) {
  const d = document.getElementById("volunteer-filter-select");
  if (filter && d && d.value !== filter) d.value = filter;
  const selectedStatus = (d?.value || "all").toLowerCase();
  const searchInput = document.getElementById("volunteer-search-input");
  const query = (searchInput?.value || "").trim().toLowerCase();

  let visible = 0;
  document.querySelectorAll(".volunteer-row").forEach((r) => {
    const rs = (r.getAttribute("data-status") || "").toLowerCase();
    const rowText = r.textContent.toLowerCase();

    const matchesStatus = selectedStatus === "all" || rs === selectedStatus;
    const matchesQuery = !query || rowText.includes(query);

    const show = matchesStatus && matchesQuery;
    r.style.display = show ? "" : "none";
    if (show) visible++;
  });
  const rc = document.getElementById("volunteer-result-count");
  if (rc)
    rc.textContent = `${visible} ${visible === 1 ? "record" : "records"}`;
};

window.deleteVolunteerRecord = function (id, name = "Volunteer") {
  window.showConfirmPopup(
    "Delete Volunteer Application?",
    `Are you sure you want to delete the application record for "${name}"? This will delete this specific entry.`,
    async () => {
      window.showLoading();
      try {
        await deleteDoc(doc(db, "volunteers", id));
        if (typeof window.closeVolunteerDetailsModal === "function") {
          window.closeVolunteerDetailsModal();
        }
        window.showAdminAlert("Application Deleted", "Volunteer record removed.", true);
      } catch (err) {
        window.showAdminAlert("Error", err.message, false);
      } finally {
        window.hideLoading();
      }
    },
  );
};
window.sortVolunteers = function (value) {
  const [f, d] = value.split("-");
  volunteerSortField = f;
  volunteerSortDirection = d;
  const sd = document.getElementById("volunteer-sort-select");
  if (sd) sd.value = value;
  renderSortedVolunteers();
  const fd = document.getElementById("volunteer-filter-select");
  if (fd?.value !== "all") window.filterVolunteers(fd?.value || "all");
};
window.clearVolunteers = function () {
  const tbody = document.getElementById("admin-volunteers-tbody");
  if (!tbody) return;
  const rows = tbody.querySelectorAll("tr.volunteer-row");
  const vr = Array.from(rows).filter((r) => r.style.display !== "none");
  if (vr.length === 0) {
    window.showAdminAlert("No Volunteers", "No visible volunteers.", false);
    return;
  }
  window.showConfirmPopup(
    "Clear Volunteers",
    `Move ${vr.length} volunteer(s) to trash?`,
    async () => {
      window.showLoading();
      try {
        const b = writeBatch(db);
        let c = 0;
        const vd = [];
        vr.forEach((row) => {
          const cells = row.querySelectorAll("td");
          if (cells.length >= 1)
            vd.push({ name: cells[0]?.textContent.trim() || "" });
        });
        const s = await getDocs(
          query(
            collection(db, "volunteers"),
            where("status", "!=", STATUS.TRASHED),
          ),
        );
        s.forEach((d) => {
          const data = d.data();
          const fn = data.name || "";
          const m = vd.some((v) => v.name === fn);
          if (m) {
            b.update(d.ref, {
              status: STATUS.TRASHED,
              trashedAt: serverTimestamp(),
              trashedBy: getAdminDisplayName(),
              trashedById: loggedInAdmin?.id || "system",
              previousStatus: data.status,
            });
            c++;
          }
        });
        if (c > 0) {
          await b.commit();
          allVolunteers = [];
          window.showAdminAlert(
            "Volunteers Moved to Trash",
            `${c} volunteer(s) moved.`,
            true,
          );
        } else
          window.showAdminAlert("No Changes", "No matching volunteers.", false);
      } catch (err) {
        window.showAdminAlert("Error", "Failed: " + err.message, false);
      } finally {
        window.hideLoading();
      }
    },
  );
};
window.viewVolunteerTrash = async function () {
  window.showLoading();
  try {
    const s = await getDocs(
      query(
        collection(db, "volunteers"),
        where("status", "==", STATUS.TRASHED),
      ),
    );
    const tv = [];
    s.forEach((d) => {
      tv.push({ id: d.id, ...d.data() });
    });
    tv.sort((a, b) => {
      const dA = a.trashedAt?.toDate
        ? a.trashedAt.toDate()
        : new Date(a.trashedAt || 0);
      const dB = b.trashedAt?.toDate
        ? b.trashedAt.toDate()
        : new Date(b.trashedAt || 0);
      return dB - dA;
    });
    const em = document.getElementById("volunteer-trash-modal");
    if (em) em.remove();
    const modal = document.createElement("div");
    modal.className =
      "fixed inset-0 bg-gray-900/80 backdrop-blur-sm flex items-center justify-center p-4 z-[180] overflow-hidden";
    modal.id = "volunteer-trash-modal";
    modal.addEventListener("click", function (e) {
      if (e.target === modal) modal.remove();
    });
    let tr = "";
    if (tv.length === 0) {
      tr = `<tr><td colspan="7" class="px-4 py-10 text-center text-gray-400"><i class="fa-solid fa-trash-can text-4xl mb-3 block text-gray-300"></i><p class="text-lg font-bold text-gray-500">Trash is Empty</p></td></tr>`;
    } else {
      tv.forEach((v) => {
        const id = v.id;
        let psb = "";
        if (v.previousStatus === STATUS.APPROVED)
          psb =
            '<span class="badge-success px-2 py-0.5 rounded text-xs font-bold">Approved</span>';
        else if (v.previousStatus === STATUS.REJECTED)
          psb =
            '<span class="badge-danger px-2 py-0.5 rounded text-xs font-bold">Rejected</span>';
        else
          psb =
            '<span class="badge-warning px-2 py-0.5 rounded text-xs font-bold">Pending</span>';
        const tdd = v.trashedAt ? formatFirebaseTimestamp(v.trashedAt) : "N/A";
        const cd = v.createdAt ? formatFirebaseTimestamp(v.createdAt) : "N/A";
        tr += `<tr class="border-b bg-red-50/30 hover:bg-red-100/50"><td class="px-4 py-3"><div class="font-bold">${v.name || "N/A"}</div><div class="text-[10px] text-red-500"><i class="fa-solid fa-trash-can mr-1"></i>Deleted: ${tdd}</div><div class="text-[10px] text-stone-400">By: ${v.trashedBy || "Admin"}</div></td><td class="px-4 py-3 text-sm">${v.email || "N/A"}<br>${v.phone || "N/A"}</td><td class="px-4 py-3 text-sm">${v.skills || "N/A"}</td><td class="px-4 py-3 text-sm">${v.availability || "N/A"}</td><td class="px-4 py-3 text-xs">${cd}</td><td class="px-4 py-3">${psb}</td><td class="px-4 py-3"><div class="flex gap-1.5"><button onclick="event.stopPropagation();restoreVolunteer('${id}')" class="text-xs px-3 py-2 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 font-medium"><i class="fa-solid fa-rotate-left"></i> Restore</button><button onclick="event.stopPropagation();permanentlyDeleteVolunteer('${id}')" class="text-xs px-3 py-2 rounded-lg bg-red-500 text-white hover:bg-red-600 font-medium"><i class="fa-solid fa-trash"></i> Delete</button></div></td></tr>`;
      });
    }
    modal.innerHTML = `<div class="bg-white rounded-2xl w-full max-w-6xl max-h-[90vh] shadow-2xl border border-gray-200 modal-enter flex flex-col" style="margin:auto"><div class="p-6 border-b flex items-center justify-between shrink-0 bg-white rounded-t-2xl"><div><h2 class="text-xl font-extrabold text-red-700"><i class="fa-solid fa-trash-can"></i> Trash - Deleted Volunteers</h2><p class="text-sm text-stone-500">${tv.length || 0} volunteer(s) in trash</p></div><div class="flex items-center gap-3">${tv.length > 0 ? `<button onclick="emptyVolunteerTrash()" class="text-xs px-4 py-2 rounded-lg bg-red-500 text-white hover:bg-red-600 font-semibold"><i class="fa-solid fa-trash-can"></i> Empty Trash</button><button onclick="restoreAllVolunteers()" class="text-xs px-4 py-2 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 font-semibold"><i class="fa-solid fa-rotate-left"></i> Restore All</button>` : ""}<button onclick="document.getElementById('volunteer-trash-modal').remove()" class="text-gray-400 hover:text-gray-600 p-2"><i class="fa-solid fa-xmark text-xl"></i></button></div></div><div class="overflow-y-auto flex-1" style="min-height:0"><table class="w-full text-sm"><thead class="sticky top-0 z-10"><tr class="bg-red-50 text-xs font-semibold text-red-700 uppercase"><th class="px-4 py-3 text-left bg-red-50">Name</th><th class="px-4 py-3 text-left bg-red-50">Contact</th><th class="px-4 py-3 text-left bg-red-50">Skills</th><th class="px-4 py-3 text-left bg-red-50">Availability</th><th class="px-4 py-3 text-left bg-red-50">Date</th><th class="px-4 py-3 text-left bg-red-50">Prev Status</th><th class="px-4 py-3 text-left bg-red-50">Actions</th></tr></thead><tbody class="divide-y divide-gray-100">${tr}</tbody></table></div><div class="p-4 border-t bg-gray-50 shrink-0 rounded-b-2xl"><p class="text-xs text-stone-400 text-center"><i class="fa-solid fa-info-circle mr-1"></i>Trashed volunteers can be restored.</p></div></div>`;
    document.body.appendChild(modal);
    window.hideLoading();
  } catch (err) {
    window.hideLoading();
    window.showAdminAlert("Error", "Failed: " + err.message, false);
  }
};
window.restoreVolunteer = function (id) {
  window.showConfirmPopup("Restore Volunteer", "Restore?", async () => {
    window.showLoading();
    try {
      const d = await getDoc(doc(db, "volunteers", id));
      if (!d.exists()) {
        window.hideLoading();
        window.showAdminAlert("Error", "Not found.", false);
        return;
      }
      await updateDoc(doc(db, "volunteers", id), {
        status: d.data().previousStatus || STATUS.PENDING,
        restoredAt: serverTimestamp(),
        restoredBy: getAdminDisplayName(),
        restoredById: loggedInAdmin?.id || "system",
        trashedAt: null,
        trashedBy: null,
        trashedById: null,
        previousStatus: null,
      });
      const m = document.getElementById("volunteer-trash-modal");
      if (m) m.remove();
      window.showAdminAlert("Volunteer Restored", "Restored.", true);
    } catch (err) {
      window.hideLoading();
      window.showAdminAlert("Error", "Failed: " + err.message, false);
    } finally {
      window.hideLoading();
    }
  });
};
window.permanentlyDeleteVolunteer = function (id) {
  window.showConfirmPopup(
    "Permanently Delete",
    "Cannot be undone.",
    async () => {
      window.showLoading();
      try {
        await deleteDoc(doc(db, "volunteers", id));
        const m = document.getElementById("volunteer-trash-modal");
        if (m) m.remove();
        window.showAdminAlert(
          "Volunteer Deleted",
          "Permanently deleted.",
          true,
        );
      } catch (err) {
        window.hideLoading();
        window.showAdminAlert("Error", "Failed: " + err.message, false);
      } finally {
        window.hideLoading();
      }
    },
  );
};
window.emptyVolunteerTrash = function () {
  window.showConfirmPopup(
    "Empty Volunteer Trash",
    "Delete ALL trashed?",
    async () => {
      window.showLoading();
      try {
        const s = await getDocs(
          query(
            collection(db, "volunteers"),
            where("status", "==", STATUS.TRASHED),
          ),
        );
        if (s.empty) {
          window.hideLoading();
          window.showAdminAlert("Trash Empty", "No volunteers.", false);
          return;
        }
        const b = writeBatch(db);
        let c = 0;
        s.forEach((d) => {
          b.delete(d.ref);
          c++;
        });
        await b.commit();
        const m = document.getElementById("volunteer-trash-modal");
        if (m) m.remove();
        window.showAdminAlert("Trash Emptied", `${c} deleted.`, true);
      } catch (err) {
        window.hideLoading();
        window.showAdminAlert("Error", "Failed: " + err.message, false);
      } finally {
        window.hideLoading();
      }
    },
  );
};
window.restoreAllVolunteers = function () {
  window.showConfirmPopup(
    "Restore All Volunteers",
    "Restore ALL?",
    async () => {
      window.showLoading();
      try {
        const s = await getDocs(
          query(
            collection(db, "volunteers"),
            where("status", "==", STATUS.TRASHED),
          ),
        );
        if (s.empty) {
          window.hideLoading();
          window.showAdminAlert("Trash Empty", "No volunteers.", false);
          return;
        }
        const b = writeBatch(db);
        let c = 0;
        s.forEach((d) => {
          const data = d.data();
          b.update(d.ref, {
            status: data.previousStatus || STATUS.PENDING,
            restoredAt: serverTimestamp(),
            restoredBy: getAdminDisplayName(),
            restoredById: loggedInAdmin?.id || "system",
            trashedAt: null,
            trashedBy: null,
            trashedById: null,
            previousStatus: null,
          });
          c++;
        });
        await b.commit();
        const m = document.getElementById("volunteer-trash-modal");
        if (m) m.remove();
        window.showAdminAlert("All Restored", `${c} restored.`, true);
      } catch (err) {
        window.hideLoading();
        window.showAdminAlert("Error", "Failed: " + err.message, false);
      } finally {
        window.hideLoading();
      }
    },
  );
};
window.printVolunteers = function () {
  const tbody = document.getElementById("admin-volunteers-tbody");
  if (!tbody) return;
  const rows = tbody.querySelectorAll("tr.volunteer-row");
  const vr = Array.from(rows).filter((r) => r.style.display !== "none");
  if (vr.length === 0) {
    window.showAdminAlert("No Data", "No volunteers to print.", false);
    return;
  }
  const cf = document.getElementById("volunteer-filter-select")?.value || "all";
  const fl = {
    all: "All Volunteers",
    Approved: "Approved Volunteers",
    Pending: "Pending Volunteers",
    Rejected: "Rejected Volunteers",
  };
  const n = new Date();
  const ds = n.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const ts = n.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const pw = window.open("", "_blank");
  pw.document.write(
    `<!DOCTYPE html><html><head><title>Volunteers Report</title><style>body{font-family:Arial;padding:20px;color:#333}.header{text-align:center;margin-bottom:30px;border-bottom:2px solid #003B71;padding-bottom:20px}.header h1{color:#003B71;margin:0;font-size:24px}.header p{color:#666;margin:5px 0;font-size:14px}table{width:100%;border-collapse:collapse;margin-top:20px}th{background-color:#003B71;color:white;padding:12px;text-align:left;font-size:12px}td{padding:10px 12px;border-bottom:1px solid #ddd;font-size:13px}tr:nth-child(even){background-color:#f9f9f9}.footer{margin-top:30px;text-align:center;font-size:12px;color:#999}@media print{body{padding:0}}</style></head><body><div class="header"><h1>Municipality of Victoria</h1><p>Volunteers Report</p><p>${fl[cf] || "All Volunteers"} | ${ds} at ${ts}</p><p>Generated by: ${getAdminDisplayName()}</p></div><table><thead><tr><th>Name</th><th>Contact</th><th>Skills</th><th>Availability</th><th>Status</th></tr></thead><tbody>${vr
      .map((r) => {
        const c = r.querySelectorAll("td");
        if (c.length >= 6)
          return `<tr><td>${c[0]?.textContent.trim() || ""}</td><td>${c[1]?.textContent.trim() || ""}</td><td>${c[2]?.textContent.trim() || ""}</td><td>${c[3]?.textContent.trim() || ""}</td><td>${c[5]?.textContent.trim() || ""}</td></tr>`;
        return "";
      })
      .join(
        "",
      )}</tbody></table><div class="footer"><p>Official Volunteers Report</p><p>Generated: ${ds} at ${ts}</p></div></body></html>`,
  );
  pw.document.close();
  setTimeout(() => pw.print(), 500);
};
function initVolunteersListener() {
  const tbody = document.getElementById("admin-volunteers-tbody");
  if (!tbody) return;
  const dropdown = document.getElementById("volunteer-filter-select");
  if (dropdown) dropdown.value = "all";
  const sortDropdown = document.getElementById("volunteer-sort-select");
  if (sortDropdown) sortDropdown.value = "date-desc";
  onSnapshot(
    query(collection(db, "volunteers"), orderBy("createdAt", "desc")),
    (snapshot) => {
      if (snapshot.empty) {
        tbody.innerHTML =
          '<tr><td colspan="7" class="px-4 py-6 text-center text-stone-400">No volunteer applications yet.</td></tr>';
        allVolunteers = [];
        const rc0 = document.getElementById("volunteer-result-count");
        if (rc0) rc0.textContent = "0 records";
        refreshActionBadges();
        return;
      }
      allVolunteers = [];
      snapshot.forEach((d) => {
        allVolunteers.push({ id: d.id, ...d.data() });
      });
      renderSortedVolunteers();
      refreshActionBadges();
      const cf = dropdown?.value || "all";
      window.filterVolunteers(cf || "all");
    },
  );
}
function renderSortedVolunteers() {
  const tbody = document.getElementById("admin-volunteers-tbody");
  if (!tbody) return;
  const sv = [...allVolunteers].sort((a, b) => {
    if (volunteerSortField === "name") {
      const nA = (a.name || "").toLowerCase(),
        nB = (b.name || "").toLowerCase();
      return volunteerSortDirection === "asc"
        ? nA.localeCompare(nB)
        : nB.localeCompare(nA);
    } else {
      const dA = a.createdAt?.toDate
        ? a.createdAt.toDate()
        : new Date(a.createdAt || 0),
        dB = b.createdAt?.toDate
          ? b.createdAt.toDate()
          : new Date(b.createdAt || 0);
      return volunteerSortDirection === "asc" ? dA - dB : dB - dA;
    }
  });
  if (sv.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="7" class="px-4 py-6 text-center text-stone-400">No volunteer applications yet.</td></tr>';
    const rc0 = document.getElementById("volunteer-result-count");
    if (rc0) rc0.textContent = "0 records";
    return;
  }
  let html = "";
  sv.forEach((v) => {
    const id = v.id;
    let sb = "";
    if (v.status === STATUS.APPROVED)
      sb =
        '<span class="badge-success px-2 py-0.5 rounded text-xs font-bold">Approved</span>';
    else if (v.status === STATUS.REJECTED)
      sb =
        '<span class="badge-danger px-2 py-0.5 rounded text-xs font-bold">Rejected</span>';
    else
      sb =
        '<span class="badge-warning px-2 py-0.5 rounded text-xs font-bold">Pending</span>';
    const skillsDisplay = v.skills || "N/A";
    const experienceDisplay = v.experience
      ? `<span class="text-xs text-stone-500 block mt-1">Experience: ${v.experience}</span>`
      : "";

    // Document display
    let docDisplay = '<span class="text-xs text-stone-400">No document</span>';
    if (v.verificationFile && v.verificationFile.data) {
      const fn = v.verificationFile.fileName || "Document";
      const truncatedName = fn.length > 20 ? fn.substring(0, 17) + "..." : fn;
      const fe = fn.split(".").pop().toLowerCase();
      let fileIcon = "fa-file";
      if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(fe))
        fileIcon = "fa-file-image";
      else if (fe === "pdf") fileIcon = "fa-file-pdf";
      else if (["doc", "docx"].includes(fe)) fileIcon = "fa-file-word";
      else if (["xls", "xlsx"].includes(fe)) fileIcon = "fa-file-excel";
      else if (["ppt", "pptx"].includes(fe)) fileIcon = "fa-file-powerpoint";
      else if (["zip", "rar"].includes(fe)) fileIcon = "fa-file-zipper";
      else fileIcon = "fa-file-lines";
      docDisplay = `
      <div class="flex items-center gap-1.5" title="${fn}">
        <div class="flex items-center gap-1.5 cursor-pointer hover:opacity-80 transition-opacity" 
             onclick="event.stopPropagation();viewVerificationFile('${id}')" 
             title="Click to preview: ${fn}">
          <i class="fa-solid ${fileIcon} text-victoria-blue text-sm shrink-0"></i>
          <span class="text-xs text-victoria-blue font-medium truncate max-w-[105px] hover:underline">${truncatedName}</span>
        </div>
        <button type="button" 
                onclick="event.stopPropagation();downloadVolunteerFile('${id}')" 
                class="w-7 h-7 rounded-lg bg-emerald-50 text-emerald-600 hover:bg-emerald-600 hover:text-white transition-all flex items-center justify-center shrink-0"
                title="Download: ${fn}">
          <i class="fa-solid fa-download text-xs"></i>
        </button>
      </div>`;
    }

    // Contact display - email only, truncated
    // Contact display - email only, shorter truncation, fixed width
    const email = v.email || "N/A";
    const truncatedEmail =
      email.length > 18 ? email.substring(0, 15) + "..." : email;
    const contactDisplay = `
  <div class="text-xs text-stone-600 w-[160px]" title="${email}">
    <i class="fa-solid fa-envelope mr-1 text-stone-400 shrink-0"></i>
    <span class="truncate inline-block max-w-[130px] align-middle">${truncatedEmail}</span>
  </div>`;

    // Actions - stacked vertically with proper spacing
    let actionsHtml = '<div class="flex flex-col gap-1.5">';
    if (v.status === STATUS.PENDING) {
      actionsHtml += `
      <button onclick="updateVolunteerStatus('${id}','${STATUS.APPROVED}')" 
        class="text-xs bg-emerald-50 text-emerald-600 px-3 py-2 rounded-lg hover:bg-emerald-600 hover:text-white transition-all font-medium w-full text-left whitespace-nowrap">
        <i class="fa-solid fa-check mr-1.5"></i>Approve
      </button>`;
      actionsHtml += `
      <button onclick="updateVolunteerStatus('${id}','${STATUS.REJECTED}')" 
        class="text-xs bg-red-50 text-red-600 px-3 py-2 rounded-lg hover:bg-red-600 hover:text-white transition-all font-medium w-full text-left whitespace-nowrap">
        <i class="fa-solid fa-xmark mr-1.5"></i>Reject
      </button>`;
    }
    if (v.status !== STATUS.PENDING) {
      actionsHtml += `
      <button onclick="updateVolunteerStatus('${id}','${STATUS.PENDING}')" 
        class="text-xs bg-amber-50 text-amber-600 px-3 py-2 rounded-lg hover:bg-amber-600 hover:text-white transition-all font-medium w-full text-left whitespace-nowrap">
        <i class="fa-solid fa-rotate mr-1.5"></i>Reset
      </button>`;
    }
    actionsHtml += "</div>";

    const notesDisplay = v.notes
      ? `<div class="mt-1"><button onclick="event.stopPropagation();viewVolunteerNotes('${(v.notes || "").replace(/'/g, "\\'").replace(/"/g, "&quot;").replace(/\n/g, "<br>")}','${(v.name || "Volunteer").replace(/'/g, "\\'")}')" class="text-xs bg-amber-50 text-amber-600 px-2 py-1 rounded hover:bg-amber-600 hover:text-white"><i class="fa-solid fa-note-sticky mr-1"></i>Notes</button></div>`
      : "";
    const isNew =
      (v.status || STATUS.PENDING) === STATUS.PENDING &&
      v.status !== STATUS.TRASHED;
    const escVid = (v.id || "").replace(/'/g, "\\'");
    const escVname = (v.name || "Volunteer").replace(/'/g, "\\'");
    html += `<tr class="${isNew ? "row-new " : ""}hover:bg-blue-50/60 cursor-pointer border-b table-row volunteer-row transition-colors" data-status="${v.status || "Pending"}" onclick="openVolunteerDetailsModal('${id}')"><td class="px-4 py-3"><div class="font-bold text-stone-900">${v.name || "N/A"}${isNew ? " " + newChipHtml() : ""}</div>${notesDisplay}</td><td class="px-4 py-3">${contactDisplay}</td><td class="px-4 py-3"><div class="text-sm font-semibold text-stone-800">${skillsDisplay}</div>${experienceDisplay}</td><td class="px-4 py-3 text-sm text-stone-600">${v.availability || "N/A"}</td><td class="px-4 py-3" onclick="event.stopPropagation()">${docDisplay}</td><td class="px-4 py-3">${sb}</td><td class="px-4 py-3 text-right" onclick="event.stopPropagation()"><button type="button" onclick="deleteVolunteerRecord('${escVid}', '${escVname}')" class="w-8 h-8 rounded text-slate-400 hover:bg-rose-50 hover:text-rose-600 transition-all inline-flex items-center justify-center" title="Delete specific volunteer record"><i class="fa-solid fa-trash-can text-xs"></i></button></td></tr>`;
  });
  tbody.innerHTML = html;
  window.filterVolunteers();
}
window.viewVerificationFile = async function (id) {
  window.showLoading();
  try {
    const s = await getDoc(doc(db, "volunteers", id));
    if (!s.exists()) {
      window.hideLoading();
      window.showAdminAlert("Error", "Not found.", false);
      return;
    }
    const d = s.data();
    if (!d.verificationFile?.data) {
      window.hideLoading();
      window.showAdminAlert("No File", "No document uploaded.", false);
      return;
    }
    const fd = d.verificationFile.data,
      fn = d.verificationFile.fileName || "file",
      ft = d.verificationFile.fileType || "application/octet-stream",
      ua = d.verificationFile.uploadedAt
        ? new Date(d.verificationFile.uploadedAt).toLocaleString()
        : "Unknown";
    const modal = document.createElement("div");
    modal.className =
      "fixed inset-0 bg-gray-900/80 backdrop-blur-sm flex items-center justify-center p-4 z-[320]";
    modal.id = "verification-viewer-modal";
    modal.onclick = function (e) {
      if (e.target === this) this.remove();
    };
    let ch = "";
    const fe = fn.split(".").pop().toLowerCase();

    // Buttons for the preview modal footer
    const downloadBtn = `<a href="${fd}" download="${fn}" class="flex items-center justify-center gap-2 bg-victoria-blue text-white font-semibold py-3 px-6 rounded-xl text-sm hover:bg-victoria-accent transition-colors"><i class="fa-solid fa-download"></i> Download File</a>`;
    const closeBtn = `<button onclick="document.getElementById('verification-viewer-modal').remove()" class="flex items-center justify-center gap-2 bg-gray-100 text-gray-700 font-semibold py-3 px-6 rounded-xl text-sm hover:bg-gray-200 transition-colors"><i class="fa-solid fa-xmark"></i> Close</button>`;

    if (
      ft.startsWith("image/") ||
      [
        "png",
        "jpg",
        "jpeg",
        "gif",
        "webp",
        "svg",
        "bmp",
        "ico",
        "tiff",
        "tif",
      ].includes(fe)
    ) {
      ch = `<div class="bg-white rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-hidden shadow-2xl border modal-enter flex flex-col">
        <div class="p-4 border-b flex items-center justify-between shrink-0 bg-white">
          <div>
            <h3 class="text-lg font-extrabold text-victoria-blue flex items-center gap-2"><i class="fa-solid fa-file-image"></i> Image Preview</h3>
            <p class="text-xs text-stone-500 mt-0.5">${fn} | Uploaded by ${d.name || "Volunteer"} on ${ua}</p>
          </div>
          <button onclick="document.getElementById('verification-viewer-modal').remove()" class="text-gray-400 hover:text-gray-600 p-2 hover:bg-gray-100 rounded-lg transition-all"><i class="fa-solid fa-xmark text-xl"></i></button>
        </div>
        <div class="flex-1 bg-gray-100 p-4 flex items-center justify-center" style="min-height:0">
          <img src="${fd}" alt="${fn}" class="max-w-full max-h-full object-contain rounded-lg shadow-md">
        </div>
      </div>`;
    } else if (ft === "application/pdf" || fe === "pdf") {
      ch = `<div class="bg-white rounded-2xl max-w-5xl w-full max-h-[90vh] overflow-hidden shadow-2xl border modal-enter flex flex-col">
        <div class="p-4 border-b flex items-center justify-between shrink-0 bg-white">
          <div>
            <h3 class="text-sm font-extrabold text-victoria-blue flex items-center gap-2"><i class="fa-solid fa-file-pdf"></i> PDF Preview</h3>
            <p class="text-xs text-stone-500 mt-0.5">${fn} | Uploaded by ${d.name || "Volunteer"} on ${ua}</p>
          </div>
          <button onclick="document.getElementById('verification-viewer-modal').remove()" class="text-gray-400 hover:text-gray-600 p-2 hover:bg-gray-100 rounded-lg transition-all"><i class="fa-solid fa-xmark text-xl"></i></button>
        </div>
        <div class="flex-1 bg-gray-100" style="min-height:0">
          <embed src="${fd}" type="application/pdf" width="100%" height="100%" class="w-full h-full">
        </div>
      </div>`;
    } else if (["doc", "docx", "xls", "xlsx", "ppt", "pptx"].includes(fe)) {
      let officeIcon = "fa-file-word";
      if (["xls", "xlsx"].includes(fe)) officeIcon = "fa-file-excel";
      else if (["ppt", "pptx"].includes(fe)) officeIcon = "fa-file-powerpoint";
      ch = `<div class="bg-white rounded-2xl max-w-5xl w-full max-h-[90vh] overflow-hidden shadow-2xl border modal-enter flex flex-col">
        <div class="p-4 border-b flex items-center justify-between shrink-0 bg-white">
          <div>
            <h3 class="text-lg font-extrabold text-victoria-blue flex items-center gap-2"><i class="fa-solid ${officeIcon}"></i> Document Preview</h3>
            <p class="text-xs text-stone-500 mt-0.5">${fn} | Uploaded by ${d.name || "Volunteer"} on ${ua}</p>
          </div>
          <button onclick="document.getElementById('verification-viewer-modal').remove()" class="text-gray-400 hover:text-gray-600 p-2 hover:bg-gray-100 rounded-lg transition-all"><i class="fa-solid fa-xmark text-xl"></i></button>
        </div>
        <div class="flex-1 bg-gray-100" style="min-height:0">
          <iframe src="https://docs.google.com/gview?url=${encodeURIComponent(fd)}&embedded=true" width="100%" height="100%" frameborder="0" class="w-full h-full"></iframe>
        </div>
      </div>`;
    } else {
      const fileIcon =
        fe === "txt"
          ? "fa-file-lines"
          : fe === "zip" || fe === "rar"
            ? "fa-file-zipper"
            : "fa-file";
      ch = `<div class="bg-white rounded-2xl max-w-md w-full shadow-2xl border modal-enter">
        <div class="p-6 text-center">
          <div class="w-20 h-20 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-4 text-3xl"><i class="fa-solid ${fileIcon}"></i></div>
          <h3 class="text-lg font-extrabold text-victoria-blue mb-2">File Available</h3>
          <p class="text-sm text-stone-600 mb-1 font-medium">${fn}</p>
          <p class="text-xs text-stone-400 mb-1">Type: ${ft || "Unknown"}</p>
          <p class="text-xs text-stone-400 mb-4">Uploaded by ${d.name || "Volunteer"} on ${ua}</p>
          <div class="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-5">
            <p class="text-xs text-amber-700 flex items-center justify-center gap-1.5"><i class="fa-solid fa-circle-info"></i> Preview not available for this file type.</p>
          </div>
          <div class="flex items-center justify-center gap-3">${downloadBtn}${closeBtn}</div>
        </div>
      </div>`;
    }
    modal.innerHTML = ch;
    document.body.appendChild(modal);
    // Convert inline data-URL download links to blob URLs so files download reliably
    modal.querySelectorAll('a[download][href^="data:"]').forEach((anchor) => {
      try {
        const url = anchor.getAttribute("href");
        const parts = url.split(",");
        const mime =
          (parts[0].match(/data:(.*?);/) || [])[1] ||
          "application/octet-stream";
        const byteString = atob(parts[1] || "");
        const bytes = new Uint8Array(byteString.length);
        for (let i = 0; i < byteString.length; i++)
          bytes[i] = byteString.charCodeAt(i);
        anchor.href = URL.createObjectURL(new Blob([bytes], { type: mime }));
      } catch (e) { }
    });
    window.hideLoading();
  } catch (err) {
    window.hideLoading();
    window.showAdminAlert("Error", "Failed to load file preview.", false);
  }
};

// ==================== ANTI-DEBUGGING & DEVELOPER TOOLS PROTECTION ====================
(function () {
  // Disable right-click context menu
  document.addEventListener("contextmenu", function (e) {
    e.preventDefault();
    return false;
  });

  // Disable keyboard shortcuts for developer tools
  document.addEventListener("keydown", function (e) {
    // F12 key
    if (e.keyCode === 123) {
      e.preventDefault();
      return false;
    }

    // Ctrl+Shift+I (Chrome, Firefox Dev Tools)
    if (e.ctrlKey && e.shiftKey && e.keyCode === 73) {
      e.preventDefault();
      return false;
    }

    // Ctrl+Shift+J (Chrome Console)
    if (e.ctrlKey && e.shiftKey && e.keyCode === 74) {
      e.preventDefault();
      return false;
    }

    // Ctrl+Shift+C (Chrome Element Selector)
    if (e.ctrlKey && e.shiftKey && e.keyCode === 67) {
      e.preventDefault();
      return false;
    }

    // Ctrl+U (View Source)
    if (e.ctrlKey && e.keyCode === 85) {
      e.preventDefault();
      return false;
    }

    // Ctrl+S (Save Page)
    if (e.ctrlKey && e.keyCode === 83) {
      e.preventDefault();
      return false;
    }

    // Ctrl+Shift+K (Firefox Console)
    if (e.ctrlKey && e.shiftKey && e.keyCode === 75) {
      e.preventDefault();
      return false;
    }

    // Ctrl+Shift+E (Firefox Network Tab)
    if (e.ctrlKey && e.shiftKey && e.keyCode === 69) {
      e.preventDefault();
      return false;
    }

    // F5 and Ctrl+R (Refresh - optional, might want to allow refresh)
    // if (e.keyCode === 116 || (e.ctrlKey && e.keyCode === 82)) {
    //     e.preventDefault();
    //     return false;
    // }
  });

  // Detect if Developer Tools is open using various methods
  function detectDevTools() {
    const threshold = 160;
    const widthThreshold = window.outerWidth - window.innerWidth > threshold;
    const heightThreshold = window.outerHeight - window.innerHeight > threshold;

    // Method 1: Window size difference detection
    if (widthThreshold || heightThreshold) {
      handleDevToolsDetected();
    }

    // Method 2: Console.log timing detection
    const startTime = performance.now();
    debugger;
    const endTime = performance.now();

    if (endTime - startTime > 100) {
      handleDevToolsDetected();
    }

    // Method 3: Firefox specific detection
    if (window.devtools && window.devtools.open) {
      handleDevToolsDetected();
    }
  }

  // Method 4: Using requestAnimationFrame to detect console
  let devtoolsOpen = false;
  const element = new Image();
  Object.defineProperty(element, "id", {
    get: function () {
      devtoolsOpen = true;
      handleDevToolsDetected();
    },
  });

  setInterval(function () {
    devtoolsOpen = false;
    console.log("%c", element);
    if (devtoolsOpen) {
      handleDevToolsDetected();
    }
  }, 1000);

  // Method 5: Detect Firebug
  if (window.console && (window.console.firebug || window.console.exception)) {
    handleDevToolsDetected();
  }

  function handleDevToolsDetected() {
    // Clear console
    console.clear();

    // Show warning
    console.log(
      "%c⚠️ WARNING ⚠️",
      "color: red; font-size: 30px; font-weight: bold;",
    );
    console.log(
      "%cDeveloper tools detected!",
      "color: orange; font-size: 20px;",
    );
    console.log(
      "%cThis action has been logged and reported to the administrator.",
      "color: red; font-size: 14px;",
    );
    console.log(
      "%cPlease close developer tools immediately.",
      "color: orange; font-size: 14px;",
    );

    // Optional: Log the attempt
    if (typeof loggedInAdmin !== "undefined" && loggedInAdmin) {
      try {
        // You can add Firestore logging here if needed
        // addDoc(collection(db, 'security_logs'), { ... });
      } catch (e) { }
    }

    // Optional: Show modal warning
    showDevToolsWarning();
  }

  function showDevToolsWarning() {
    // Remove existing warning if any
    const existing = document.getElementById("devtools-warning");
    if (existing) existing.remove();

    const warningModal = document.createElement("div");
    warningModal.id = "devtools-warning";
    warningModal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.9);
            z-index: 999999;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        `;

    warningModal.innerHTML = `
            <div style="
                background: white;
                border-radius: 20px;
                padding: 40px;
                max-width: 500px;
                width: 100%;
                text-align: center;
                box-shadow: 0 25px 50px rgba(0,0,0,0.5);
                animation: fadeInUp 0.3s ease-out;
            ">
                <div style="
                    width: 80px;
                    height: 80px;
                    background: #fee2e2;
                    color: #dc2626;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    margin: 0 auto 20px;
                    font-size: 40px;
                ">
                    <i class="fa-solid fa-triangle-exclamation"></i>
                </div>
                <h2 style="
                    color: #1f2937;
                    font-size: 24px;
                    font-weight: 800;
                    margin-bottom: 10px;
                ">⚠️ Security Warning</h2>
                <p style="
                    color: #6b7280;
                    font-size: 14px;
                    margin-bottom: 10px;
                    line-height: 1.6;
                ">
                    Developer tools have been detected on this page.
                </p>
                <p style="
                    color: #dc2626;
                    font-size: 13px;
                    font-weight: 600;
                    margin-bottom: 20px;
                    background: #fee2e2;
                    padding: 12px;
                    border-radius: 10px;
                ">
                    Using developer tools is strictly prohibited. This action has been logged.
                </p>
                <button onclick="document.getElementById('devtools-warning').remove()" style="
                    background: #2563eb;
                    color: white;
                    border: none;
                    padding: 12px 30px;
                    border-radius: 10px;
                    font-size: 14px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.3s;
                " onmouseover="this.style.background='#1d4ed8'" onmouseout="this.style.background='#2563eb'">
                    <i class="fa-solid fa-check mr-2"></i>I Understand
                </button>
            </div>
        `;

    document.body.appendChild(warningModal);
  }

  // Run detection periodically
  setInterval(detectDevTools, 2000);

  // Prevent dragging of images and links
  document.addEventListener("dragstart", function (e) {
    if (e.target.tagName === "IMG" || e.target.tagName === "A") {
      e.preventDefault();
      return false;
    }
  });

  // Prevent text selection (optional - might affect usability)
  // document.addEventListener('selectstart', function(e) {
  //     e.preventDefault();
  //     return false;
  // });

  // // Disable copy/paste (optional)
  // document.addEventListener('copy', function(e) {
  //     e.preventDefault();
  //     return false;
  // });
  // document.addEventListener('cut', function(e) {
  //     e.preventDefault();
  //     return false;
  // });

  // Override console methods to prevent logging
  const noop = function () { };
  const methods = [
    "log",
    "debug",
    "warn",
    "info",
    "error",
    "exception",
    "table",
    "trace",
  ];

  // Uncomment to completely disable console
  // methods.forEach(function(method) {
  //     console[method] = noop;
  // });

  console.log(
    "%c🔒 Admin Panel Security Active",
    "color: green; font-size: 14px; font-weight: bold;",
  );
})();

// ===== VIEW VERIFICATION FILE (UPDATED WITH DOWNLOAD IN MODAL) =====
window.viewVerificationFile = async function (id) {
  window.showLoading();
  try {
    const s = await getDoc(doc(db, "volunteers", id));
    if (!s.exists()) {
      window.hideLoading();
      window.showAdminAlert("Error", "Not found.", false);
      return;
    }
    const d = s.data();
    if (!d.verificationFile?.data) {
      window.hideLoading();
      window.showAdminAlert("No File", "No document.", false);
      return;
    }
    const fd = d.verificationFile.data,
      fn = d.verificationFile.fileName || "file",
      ft = d.verificationFile.fileType || "application/octet-stream",
      ua = d.verificationFile.uploadedAt
        ? new Date(d.verificationFile.uploadedAt).toLocaleString()
        : "Unknown";
    const modal = document.createElement("div");
    modal.className =
      "fixed inset-0 bg-gray-900/80 backdrop-blur-sm flex items-center justify-center p-4 z-[320]";
    modal.id = "verification-viewer-modal";
    modal.onclick = function (e) {
      if (e.target === this) this.remove();
    };
    let ch = "";
    const fe = fn.split(".").pop().toLowerCase();
    const downloadBtn = `<a href="${fd}" download="${fn}" class="flex-1 bg-victoria-blue text-white font-semibold py-2.5 rounded-xl text-sm hover:bg-victoria-accent transition-colors text-center flex items-center justify-center gap-1.5"><i class="fa-solid fa-download"></i> Download File</a>`;
    const closeBtn = `<button onclick="document.getElementById('verification-viewer-modal').remove()" class="flex-1 bg-gray-100 text-gray-700 font-semibold py-2.5 rounded-xl text-sm hover:bg-gray-200 transition-colors">Close</button>`;

    if (
      ft.startsWith("image/") ||
      [
        "png",
        "jpg",
        "jpeg",
        "gif",
        "webp",
        "svg",
        "bmp",
        "ico",
        "tiff",
        "tif",
      ].includes(fe)
    ) {
      ch = `<div class="bg-white rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto shadow-2xl border modal-enter"><div class="p-6"><div class="flex items-center justify-between mb-4"><div><h3 class="text-lg font-extrabold text-victoria-blue"><i class="fa-solid fa-file-image mr-2"></i>Image Preview</h3><p class="text-xs text-stone-500">${fn} | By: ${d.name || "Volunteer"} on ${ua}</p></div><button onclick="document.getElementById('verification-viewer-modal').remove()" class="text-gray-400 hover:text-gray-600 p-2"><i class="fa-solid fa-xmark text-xl"></i></button></div><div class="bg-gray-100 rounded-xl p-4 flex items-center justify-center"><img src="${fd}" alt="${fn}" class="max-w-full max-h-[65vh] object-contain rounded-lg shadow-md"></div></div></div>`;
    } else if (ft === "application/pdf" || fe === "pdf") {
      ch = `<div class="bg-white rounded-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden shadow-2xl border modal-enter flex flex-col"><div class="p-4 border-b flex items-center justify-between shrink-0"><div><h3 class="text-lg font-extrabold text-victoria-blue"><i class="fa-solid fa-file-pdf mr-2"></i>PDF Preview</h3><p class="text-xs text-stone-500">${fn} | By: ${d.name || "Volunteer"} on ${ua}</p></div><button onclick="document.getElementById('verification-viewer-modal').remove()" class="text-gray-400 hover:text-gray-600 p-2"><i class="fa-solid fa-xmark text-xl"></i></button></div><div class="flex-1 bg-gray-100" style="min-height:0"><embed src="${fd}" type="application/pdf" width="100%" height="100%" class="rounded-b-lg"></div></div>`;
    } else if (["doc", "docx", "xls", "xlsx", "ppt", "pptx"].includes(fe)) {
      ch = `<div class="bg-white rounded-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden shadow-2xl border modal-enter flex flex-col"><div class="p-4 border-b flex items-center justify-between shrink-0"><div><h3 class="text-lg font-extrabold text-victoria-blue"><i class="fa-solid fa-file-lines mr-2"></i>Document Preview</h3><p class="text-xs text-stone-500">${fn} | By: ${d.name || "Volunteer"} on ${ua}</p></div><button onclick="document.getElementById('verification-viewer-modal').remove()" class="text-gray-400 hover:text-gray-600 p-2"><i class="fa-solid fa-xmark text-xl"></i></button></div><div class="flex-1 bg-gray-100" style="min-height:0"><iframe src="https://docs.google.com/gview?url=${encodeURIComponent(fd)}&embedded=true" width="100%" height="100%" class="rounded-b-lg" frameborder="0"></iframe></div></div>`;
    } else {
      const fileIcon =
        fe === "txt"
          ? "fa-file-lines"
          : fe === "zip" || fe === "rar"
            ? "fa-file-zipper"
            : "fa-file";
      ch = `<div class="bg-white rounded-2xl max-w-md w-full shadow-2xl border modal-enter"><div class="p-6 text-center"><div class="w-16 h-16 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-4 text-2xl"><i class="fa-solid ${fileIcon}"></i></div><h3 class="text-lg font-extrabold text-victoria-blue mb-2">File Available</h3><p class="text-sm text-stone-500 mb-1">File: <span class="font-semibold text-stone-700">${fn}</span></p><p class="text-xs text-stone-400 mb-1">Type: ${ft || "Unknown"}</p><p class="text-xs text-stone-400 mb-4">Uploaded by ${d.name || "Volunteer"} on ${ua}</p><p class="text-xs text-amber-600 bg-amber-50 p-2 rounded-lg mb-4">Preview not available for this file type. Please download to view.</p><div class="flex space-x-3">${downloadBtn}${closeBtn}</div></div></div>`;
    }
    modal.innerHTML = ch;
    document.body.appendChild(modal);
    // Convert inline data-URL download links to blob URLs so files download reliably
    modal.querySelectorAll('a[download][href^="data:"]').forEach((anchor) => {
      try {
        const url = anchor.getAttribute("href");
        const parts = url.split(",");
        const mime =
          (parts[0].match(/data:(.*?);/) || [])[1] ||
          "application/octet-stream";
        const byteString = atob(parts[1] || "");
        const bytes = new Uint8Array(byteString.length);
        for (let i = 0; i < byteString.length; i++)
          bytes[i] = byteString.charCodeAt(i);
        anchor.href = URL.createObjectURL(new Blob([bytes], { type: mime }));
      } catch (e) { }
    });
    window.hideLoading();
  } catch (err) {
    window.hideLoading();
    window.showAdminAlert("Error", "Failed to load.", false);
  }
};

// ===== VOLUNTEER FILE DOWNLOAD & DETAILS MODAL =====
function escapeVolunteerHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function downloadStoredDataUrl(dataUrl, fileName) {
  try {
    const parts = String(dataUrl).split(",");
    const mime =
      (parts[0].match(/data:(.*?);/) || [])[1] || "application/octet-stream";
    const byteString = atob(parts[1] || "");
    const bytes = new Uint8Array(byteString.length);
    for (let i = 0; i < byteString.length; i++)
      bytes[i] = byteString.charCodeAt(i);
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
  } catch (e) {
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}

window.downloadVolunteerFile = async function (id) {
  window.showLoading();
  try {
    const s = await getDoc(doc(db, "volunteers", id));
    if (!s.exists() || !s.data().verificationFile?.data) {
      window.hideLoading();
      window.showAdminAlert(
        "No File",
        "This volunteer did not attach a verification document.",
        false,
      );
      return;
    }
    const file = s.data().verificationFile;
    const fileName = file.fileName || "verification-file";
    downloadStoredDataUrl(file.data, fileName);
    window.hideLoading();
    window.showAdminAlert(
      "Download Started",
      `${fileName} is downloading.`,
      true,
    );
  } catch (err) {
    window.hideLoading();
    window.showAdminAlert("Error", "Could not download the file.", false);
  }
};

window.openVolunteerDetailsModal = async function (id) {
  window.showLoading();
  try {
    const s = await getDoc(doc(db, "volunteers", id));
    if (!s.exists()) {
      window.hideLoading();
      window.showAdminAlert("Error", "Volunteer record not found.", false);
      return;
    }
    const v = s.data();
    const setText = (elId, val) => {
      const el = document.getElementById(elId);
      if (el) el.textContent = val;
    };
    setText("vol-modal-name", v.name || "Volunteer");
    setText("vol-modal-email", v.email || "Not provided");
    setText("vol-modal-phone", v.phone || v.contactNumber || "Not provided");
    setText(
      "vol-modal-skills",
      (v.skills || "Not specified") + (v.experience ? ` — ${v.experience}` : ""),
    );
    setText("vol-modal-avail", v.availability || "Flexible / Not specified");
    setText("vol-modal-notes", v.notes || "No additional notes provided.");

    const docContainer = document.getElementById("vol-modal-doc-container");
    if (docContainer) {
      if (v.verificationFile?.data) {
        const fn = escapeVolunteerHtml(
          v.verificationFile.fileName || "Verification file",
        );
        docContainer.innerHTML = `<div class="flex flex-wrap items-center gap-2">
          <button type="button" onclick="viewVerificationFile('${id}')" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-50 text-victoria-blue font-bold text-xs hover:bg-victoria-blue hover:text-white transition-all">
            <i class="fa-solid fa-file-shield"></i> View (${fn})
          </button>
          <button type="button" onclick="downloadVolunteerFile('${id}')" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-50 text-emerald-700 font-bold text-xs hover:bg-emerald-600 hover:text-white transition-all">
            <i class="fa-solid fa-download"></i> Download File
          </button>
        </div>
        <p class="text-[11px] text-stone-400 mt-1.5"><i class="fa-solid fa-paperclip mr-1"></i>${fn}${v.verificationFile.uploadedAt ? ` · uploaded ${escapeVolunteerHtml(new Date(v.verificationFile.uploadedAt).toLocaleString())}` : ""}</p>`;
      } else {
        docContainer.innerHTML =
          '<span class="text-xs text-stone-400">No document attached</span>';
      }
    }

    const actionsContainer = document.getElementById("vol-modal-actions");
    if (actionsContainer) {
      const status = v.status || STATUS.PENDING;
      let btns = "";
      if (status !== STATUS.APPROVED) {
        btns += `<button type="button" onclick="updateVolunteerStatusFromModal('${id}', '${STATUS.APPROVED}')" class="text-xs font-normal bg-emerald-600 text-white px-3.5 py-2 rounded-md hover:bg-emerald-700 shadow-sm flex items-center gap-1.5"><i class="fa-solid fa-check"></i>Approve</button>`;
      }
      if (status !== STATUS.REJECTED) {
        btns += `<button type="button" onclick="updateVolunteerStatusFromModal('${id}', '${STATUS.REJECTED}')" class="text-xs font-normal bg-rose-600 text-white px-3.5 py-2 rounded-md hover:bg-rose-700 shadow-sm flex items-center gap-1.5"><i class="fa-solid fa-xmark"></i>Reject</button>`;
      }
      if (status !== STATUS.PENDING) {
        btns += `<button type="button" onclick="updateVolunteerStatusFromModal('${id}', '${STATUS.PENDING}')" class="text-xs font-normal bg-amber-500 text-white px-3.5 py-2 rounded-md hover:bg-amber-600 shadow-sm flex items-center gap-1.5"><i class="fa-solid fa-rotate"></i>Reset</button>`;
      }
      btns += `<button type="button" onclick="deleteVolunteerRecord('${id}', '${(v.name || 'Volunteer').replace(/'/g, "\\'")}')" class="text-xs font-semibold bg-slate-100 text-rose-600 border border-rose-200 px-3.5 py-2 rounded-md hover:bg-rose-50 shadow-sm flex items-center gap-1.5 ml-auto"><i class="fa-solid fa-trash-can"></i>Delete Record</button>`;
      actionsContainer.innerHTML = btns;
    }

    const modal = document.getElementById("volunteer-details-modal");
    if (modal) {
      window.openModal(modal);
    }
    window.hideLoading();
  } catch (err) {
    window.hideLoading();
    window.showAdminAlert("Error", "Failed to load volunteer details.", false);
  }
};

window.closeVolunteerDetailsModal = function () {
  window.closeModal("volunteer-details-modal");
};

window.updateVolunteerStatusFromModal = function (id, newStatus) {
  window.closeVolunteerDetailsModal();
  window.updateVolunteerStatus(id, newStatus);
};

// ===== DOM CONTENT LOADED =====
// ===== SKELETON LOADING (FROM ORGANIZER) =====
// Placeholders shown in every tab while the first data snapshots arrive.
// Each helper only fills containers that are empty or still showing the
// initial spinner placeholder, so live data is never overwritten.
function containerAwaitingData(el) {
  if (!el) return false;
  if (!el.children.length) return true;
  return Boolean(el.querySelector(".fa-spinner"));
}

function renderAnnouncementsLoading() {
  const container = document.getElementById("announcements-container");
  if (!containerAwaitingData(container)) return;
  const skeletonCard = `<div class="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm animate-pulse">
      <div class="flex items-start justify-between gap-3">
        <div class="w-9 h-9 rounded-lg bg-slate-200"></div>
        <div class="flex items-center gap-1.5">
          <div class="w-7 h-7 rounded-lg bg-slate-100"></div>
          <div class="w-7 h-7 rounded-lg bg-slate-100"></div>
        </div>
      </div>
      <div class="flex items-center gap-2 mt-3">
        <div class="h-4 w-16 rounded-full bg-slate-200"></div>
        <div class="h-3 w-24 rounded bg-slate-100"></div>
      </div>
      <div class="h-4 w-3/4 rounded bg-slate-200 mt-3"></div>
      <div class="mt-2 rounded-lg bg-slate-100 aspect-video"></div>
      <div class="space-y-2 mt-3">
        <div class="h-3 w-full rounded bg-slate-100"></div>
        <div class="h-3 w-5/6 rounded bg-slate-100"></div>
        <div class="h-3 w-2/3 rounded bg-slate-100"></div>
      </div>
      <div class="h-3 w-28 rounded bg-slate-100 mt-3"></div>
    </div>`;
  container.innerHTML = skeletonCard.repeat(3);
}

function renderEventsLoading() {
  const grid = document.getElementById("events-grid");
  if (!containerAwaitingData(grid)) return;
  const skeletonCard = `<div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden min-h-[330px] flex flex-col animate-pulse">
      <div class="h-40 bg-slate-200"></div>
      <div class="p-5 flex flex-col flex-1">
        <div class="h-4 w-16 rounded-md bg-slate-200 mb-2"></div>
        <div class="h-4 w-4/5 rounded bg-slate-200"></div>
        <div class="space-y-2 mt-3">
          <div class="h-3 w-2/3 rounded bg-slate-100"></div>
          <div class="h-3 w-1/2 rounded bg-slate-100"></div>
          <div class="h-3 w-2/5 rounded bg-slate-100"></div>
        </div>
        <div class="flex gap-2 mt-auto pt-5">
          <div class="flex-1 h-8 rounded-lg bg-slate-100"></div>
          <div class="w-9 h-8 rounded-lg bg-slate-100"></div>
          <div class="w-9 h-8 rounded-lg bg-slate-100"></div>
        </div>
      </div>
    </div>`;
  grid.innerHTML = skeletonCard.repeat(4);
}

function skeletonTableRows(columnCount, rowCount = 5) {
  const widths = ["w-3/4", "w-2/3", "w-1/2", "w-4/5", "w-3/5"];
  let rows = "";
  for (let r = 0; r < rowCount; r += 1) {
    let cells = "";
    for (let c = 0; c < columnCount; c += 1) {
      cells += `<td class="px-4 py-4"><div class="h-3 ${widths[(r + c) % widths.length]} rounded bg-slate-200 animate-pulse"></div></td>`;
    }
    rows += `<tr>${cells}</tr>`;
  }
  return rows;
}

function renderTableLoading(tbodyId, columnCount, rowCount = 5) {
  const tbody = document.getElementById(tbodyId);
  if (!containerAwaitingData(tbody)) return;
  tbody.innerHTML = skeletonTableRows(columnCount, rowCount);
}

function renderAdminPortalLoading() {
  renderAnnouncementsLoading();
  renderEventsLoading();
  renderTableLoading("contact-messages-tbody", 6, 5);
  renderTableLoading("admin-volunteers-tbody", 7, 6);
  renderTableLoading("admin-hours-tbody", 5, 4);
  renderTableLoading("activity-logs-tbody", 4, 5);
  renderTableLoading("admin-donations-tbody", 6, 6);
  renderTableLoading("residents-tbody", 4, 6);
}

document.addEventListener("DOMContentLoaded", function () {
  initializeEventListeners();
  const loginScreen = document.getElementById("login-screen"),
    dashboard = document.getElementById("dashboard");
  const savedAdmin = getSavedAdminSession();
  // Boot loader (slow-internet aware): shows a spinner with a "slow
  // connection" notice after 8s and a 25s failsafe — replaces the old
  // artificial 800ms global-loading delay.
  showBootLoader();
  if (savedAdmin && savedAdmin.id) {
    // LOGIN REFRESH FIX: the saved session is restored immediately — a
    // page refresh (even on slow internet) never bounces the admin back
    // to the login screen; live listeners repopulate the data as it
    // arrives.
    loggedInAdmin = savedAdmin;
    if (loginScreen) loginScreen.classList.add("hidden");
    if (dashboard) dashboard.classList.remove("hidden");
    window.switchTab(getSavedActiveTab());
    renderAdminPortalLoading();
    initDigitalCheckInsListener();
    initResidentsListener();
    initActivityLogsListener();
    initDonationsListener();
    initVolunteersListener();
    initContactMessagesListener();
    updateAdminHeaderUI();
    hideBootLoader();
  } else {
    if (dashboard) dashboard.classList.add("hidden");
    if (loginScreen) loginScreen.classList.remove("hidden");
    hideBootLoader();
  }
});
function initializeEventListeners() {
  document
    .getElementById("confirm-cancel-btn")
    ?.addEventListener("click", () => {
      window.closeModal("confirm-modal");
      pendingConfirmCallback = null;
    });
  document
    .getElementById("confirm-proceed-btn")
    ?.addEventListener("click", () => {
      window.closeModal("confirm-modal");
      if (typeof pendingConfirmCallback === "function")
        pendingConfirmCallback();
      pendingConfirmCallback = null;
    });
  document
    .getElementById("login-form")
    ?.addEventListener("submit", handleLogin);
  document
    .getElementById("announcement-form")
    ?.addEventListener("submit", handleAnnouncementSubmit);
  document
    .getElementById("event-form")
    ?.addEventListener("submit", handleEventSubmit);
  document
    .getElementById("edit-event-form")
    ?.addEventListener("submit", handleEditEventSubmit);
  document
    .getElementById("hour-form")
    ?.addEventListener("submit", handleHourSubmit);
  document
    .getElementById("resident-edit-form")
    ?.addEventListener("submit", handleResidentEdit);
  document
    .getElementById("edit-announcement-form")
    ?.addEventListener("submit", handleEditAnnouncementSubmit);
  document
    .getElementById("resident-status-form")
    ?.addEventListener("submit", handleResidentStatusSubmit);
}
async function handleLogin(e) {
  e.preventDefault();
  window.showLoading();
  const ei = document.getElementById("login-email"),
    pi = document.getElementById("login-password");
  if (!ei || !pi) {
    window.hideLoading();
    window.showAdminAlert("Error", "Form not found", false);
    return;
  }
  const email = ei.value.trim(),
    pass = pi.value.trim();
  if (!email || !pass) {
    window.hideLoading();
    window.showAdminAlert("Error", "Enter email and password", false);
    return;
  }
  try {
    const q = query(
      collection(db, "admins"),
      where("email", "==", email),
      where("password", "==", pass),
    );
    // Slow-internet buffer: retry the credentials read instead of failing
    // the login on the first dropped packet.
    const snap = await withRetryBuffer(() => getDocs(q), {
      label: "admin-login",
    });
    if (!snap.empty) {
      snap.forEach((doc) => {
        const d = doc.data();
        loggedInAdmin = {
          id: doc.id,
          email,
          name: d.name || getAdminDisplayName(),
          role: d.role || "admin",
        };
      });
      saveAdminSession(loggedInAdmin);
      saveActiveTab("announcements");
      updateAdminHeaderUI();
      document.getElementById("login-screen")?.classList.add("hidden");
      document.getElementById("dashboard")?.classList.remove("hidden");
      renderAdminPortalLoading();
      initDigitalCheckInsListener();
      initResidentsListener();
      initActivityLogsListener();
      initDonationsListener();
      initVolunteersListener();
      initContactMessagesListener();
      updateAdminHeaderUI();
      window.switchTab("announcements");
      window.showAdminAlert(
        "Success",
        `Welcome, ${getAdminDisplayName()}!`,
        true,
      );
    } else window.showAdminAlert("Login Failed", "Invalid credentials.", false);
  } catch (err) {
    window.showAdminAlert("Error", err.message, false);
  } finally {
    window.hideLoading();
  }
}
async function handleAnnouncementSubmit(e) {
  e.preventDefault();
  window.showLoading();
  const t = document.getElementById("ann-title"),
    p = document.getElementById("ann-priority"),
    d = document.getElementById("ann-desc");
  if (!t || !p || !d) {
    window.hideLoading();
    window.showAdminAlert("Error", "Form not found", false);
    return;
  }
  if (!t.value.trim() || !d.value.trim()) {
    window.hideLoading();
    window.showAdminAlert("Error", "Fill all fields", false);
    return;
  }
  try {
    const selectedSource =
      typeof selectedAnnouncementImageSource === "function"
        ? selectedAnnouncementImageSource()
        : "url";
    const imageFile = document.getElementById("ann-image-file")?.files?.[0];
    let imageUrl = "";
    if (
      selectedSource === "upload" &&
      imageFile &&
      typeof prepareHighQualityImage === "function"
    ) {
      imageUrl = await prepareHighQualityImage(imageFile);
    } else if (document.getElementById("ann-image")?.value.trim()) {
      imageUrl = document.getElementById("ann-image").value.trim();
    }
    await addDoc(collection(db, "announcements"), {
      title: t.value.trim(),
      priority: p.value,
      desc: d.value.trim(),
      imageUrl: imageUrl || "",
      createdBy: getAdminDisplayName(),
      createdById: loggedInAdmin?.id || "system",
      createdAt: serverTimestamp(),
    });
    window.toggleModal("announcement-modal");
    document.getElementById("announcement-form").reset();
    if (document.getElementById("ann-image-file-label")) {
      document.getElementById("ann-image-file-label").textContent =
        "Original retained when possible · high-quality optimization · 8 MB max";
    }
    window.showAdminAlert("Success", "Posted!", true);
  } catch (err) {
    window.showAdminAlert("Error", err.message, false);
  } finally {
    window.hideLoading();
  }
}
async function handleEventSubmit(e) {
  e.preventDefault();
  window.showLoading();
  const et = document.getElementById("event-title"),
    ed = document.getElementById("event-date"),
    etm = document.getElementById("event-time"),
    el = document.getElementById("event-location"),
    ec = document.getElementById("event-category"),
    ei = document.getElementById("event-image"),
    edesc = document.getElementById("event-desc");
  if (!et || !ed || !el || !ec || !edesc) {
    window.hideLoading();
    window.showAdminAlert("Error", "Form not found", false);
    return;
  }
  const tv = et.value.trim(),
    dv = ed.value,
    lv = el.value.trim(),
    cv = ec.value,
    descv = edesc.value.trim();
  if (!tv || !dv || !lv || !cv || !descv) {
    window.hideLoading();
    window.showAdminAlert("Error", "Fill all fields", false);
    return;
  }
  try {
    const selectedSource =
      typeof selectedEventImageSource === "function"
        ? selectedEventImageSource("")
        : "url";
    const imageFile = document.getElementById("event-image-file")?.files?.[0];
    let imageUrl = "";
    if (
      selectedSource === "upload" &&
      imageFile &&
      typeof prepareHighQualityImage === "function"
    ) {
      imageUrl = await prepareHighQualityImage(imageFile);
    } else {
      imageUrl = ei?.value?.trim() || "";
    }
    const edata = {
      title: tv,
      date: dv,
      location: lv,
      type: cv,
      imageUrl: imageUrl || "",
      desc: descv,
      createdBy: getAdminDisplayName(),
      createdById: loggedInAdmin?.id || "system",
      createdAt: serverTimestamp(),
    };
    if (etm?.value?.trim()) edata.time = etm.value.trim();
    await addDoc(collection(db, "events"), edata);
    window.toggleModal("event-modal");
    document.getElementById("event-form").reset();
    if (document.getElementById("event-image-file-label")) {
      document.getElementById("event-image-file-label").textContent =
        "Original retained when possible · high-quality optimization · 8 MB max";
    }
    window.showAdminAlert("Success", "Event created!", true);
  } catch (err) {
    window.showAdminAlert("Error", err.message, false);
  } finally {
    window.hideLoading();
  }
}
// Submission-in-progress guard — prevents double-click / duplicate submits
let _editEventSubmitting = false;
async function handleEditEventSubmit(e) {
  e.preventDefault();
  if (_editEventSubmitting) return; // guard against double-submit
  const id = document.getElementById("edit-event-id")?.value;
  if (!id) {
    window.showAdminAlert("Error", "No event selected.", false);
    return;
  }
  const t = document.getElementById("edit-event-title")?.value.trim() || "",
    d = document.getElementById("edit-event-date")?.value || "",
    tm = document.getElementById("edit-event-time")?.value || "",
    l = document.getElementById("edit-event-location")?.value.trim() || "",
    c = document.getElementById("edit-event-category")?.value || "",
    i = document.getElementById("edit-event-image")?.value.trim() || "",
    desc = document.getElementById("edit-event-desc")?.value.trim() || "";
  if (!t || !d || !l || !c || !desc) {
    window.showAdminAlert("Error", "Fill all fields.", false);
    return;
  }
  _editEventSubmitting = true;
  window.showLoading();
  try {
    const selectedSource =
      typeof selectedEventImageSource === "function"
        ? selectedEventImageSource("edit-")
        : "url";
    const imageFile = document.getElementById("edit-event-image-file")
      ?.files?.[0];
    const removeImage = Boolean(
      document.getElementById("edit-event-remove-image")?.checked,
    );
    let imageUrl = "";
    if (removeImage) {
      imageUrl = "";
    } else if (
      selectedSource === "upload" &&
      imageFile &&
      typeof prepareHighQualityImage === "function"
    ) {
      imageUrl = await prepareHighQualityImage(imageFile);
    } else {
      imageUrl = i || "";
    }
    const ud = {
      title: t,
      date: d,
      location: l,
      type: c,
      imageUrl: imageUrl || "",
      desc,
      updatedBy: getAdminDisplayName(),
      updatedById: loggedInAdmin?.id || "system",
      updatedAt: serverTimestamp(),
    };
    if (tm) ud.time = tm;
    await updateDoc(doc(db, "events", id), ud);
    // Definitively close the edit modal BEFORE showing the success alert
    // so both never appear on screen simultaneously. closeModal now also
    // sets an inline display:none as a belt-and-suspenders guarantee.
    window.closeModal("edit-event-modal");
    document.getElementById("edit-event-form")?.reset();
    const editIdInput = document.getElementById("edit-event-id");
    if (editIdInput) editIdInput.value = "";
    window.showAdminAlert("Event Updated", "Event details have been updated successfully.", true);
  } catch (err) {
    window.showAdminAlert("Error", err.message, false);
  } finally {
    window.hideLoading();
    _editEventSubmitting = false;
  }
}
window.openEditEventModal = async function (id) {
  window.showLoading();
  try {
    const s = await getDoc(doc(db, "events", id));
    if (!s.exists()) {
      window.hideLoading();
      window.showAdminAlert("Error", "Not found.", false);
      return;
    }
    const e = s.data();
    document.getElementById("edit-event-id").value = id;
    document.getElementById("edit-event-title").value = e.title || "";
    document.getElementById("edit-event-date").value = e.date || "";
    document.getElementById("edit-event-time").value = e.time || "";
    document.getElementById("edit-event-location").value = e.location || "";
    document.getElementById("edit-event-category").value =
      e.type || e.category || "";
    document.getElementById("edit-event-image").value = e.imageUrl || "";
    document.getElementById("edit-event-desc").value = e.desc || "";
    window.openModal("edit-event-modal");
  } catch (err) {
    window.showAdminAlert("Error", "Failed to load.", false);
  } finally {
    window.hideLoading();
  }
};
async function handleHourSubmit(e) {
  e.preventDefault();
  const s = document.getElementById("hour-participant-select"),
    i = document.getElementById("hour-value");
  if (!s || !i) {
    window.showAdminAlert("Error", "Form not found", false);
    return;
  }
  const rid = s.value,
    hv = parseFloat(i.value);
  if (!rid) {
    window.showAdminAlert("Error", "Select participant.", false);
    return;
  }
  if (isNaN(hv) || hv <= 0) {
    window.showAdminAlert("Error", "Enter valid hours.", false);
    return;
  }
  window.showLoading();
  const ci = digitalCheckInRegistry.find((x) => x.id === rid);
  if (!ci) {
    window.hideLoading();
    window.showAdminAlert("Error", "Record not found.", false);
    return;
  }
  try {
    await addDoc(collection(db, "service_hours"), {
      residentId: ci.residentId,
      residentName: ci.residentName,
      eventTitle: ci.eventTitle,
      eventId: ci.eventId || "",
      hours: hv,
      status: STATUS.APPROVED,
      certifiedBy: getAdminDisplayName(),
      certifiedById: loggedInAdmin?.id || "system",
      certifiedAt: serverTimestamp(),
    });
    await updateDoc(doc(db, "participants", rid), {
      status: STATUS.COMPLETED,
      completedAt: serverTimestamp(),
      completedBy: getAdminDisplayName(),
      hoursCredited: hv,
    });
    await createNotification(
      ci.residentId,
      "Service Hours Credited",
      `${hv} hours credited for "${ci.eventTitle}".`,
      "hours_credited",
    );
    window.showAdminAlert(
      "Success",
      `Credited ${hv} hours to ${ci.residentName}!`,
      true,
    );
    i.value = "";
    s.value = "";
  } catch (err) {
    window.showAdminAlert("Error", err.message, false);
  } finally {
    window.hideLoading();
  }
}
function residentIsDisabled(r) {
  return r?.accountStatus === "Disabled" || r?.isDisabled === true;
}

function residentIsDeleted(r) {
  return r?.isDeleted === true || r?.accountStatus === "Deleted";
}

function initResidentsListener() {
  const tbody = document.getElementById("residents-tbody");
  if (!tbody) return;
  onSnapshot(
    query(collection(db, "residents"), orderBy("createdAt", "desc")),
    (snap) => {
      allResidents = [];
      snap.forEach((d) => allResidents.push({ id: d.id, ...d.data() }));
      renderResidents();
    },
  );
}

function renderResidents() {
  const tbody = document.getElementById("residents-tbody");
  if (!tbody) return;

  const term = (document.getElementById("resident-search")?.value || "")
    .trim()
    .toLowerCase();
  const statusFilter =
    document.getElementById("resident-status-filter")?.value || "all";

  const rows = allResidents.filter((r) => {
    const deleted = residentIsDeleted(r);
    const disabled = residentIsDisabled(r);

    // Archived accounts are hidden everywhere except their own filter, so the
    // normal registry stays clean.
    if (statusFilter === "deleted") {
      if (!deleted) return false;
    } else if (deleted) {
      return false;
    } else if (statusFilter === "active" && disabled) {
      return false;
    } else if (statusFilter === "disabled" && !disabled) {
      return false;
    }

    if (!term) return true;
    return `${r.name || ""} ${r.phone || ""} ${r.email || ""} ${r.address || ""}`
      .toLowerCase()
      .includes(term);
  });

  if (!rows.length) {
    const emptyMsg =
      statusFilter === "deleted"
        ? "No deleted accounts. Archived residents will appear here and can be restored."
        : "No residents found.";
    tbody.innerHTML = `<tr><td colspan="5" class="px-4 py-6 text-center text-stone-400">${emptyMsg}</td></tr>`;
    return;
  }

  let h = "";
  rows.forEach((r) => {
    const id = r.id;
    const deleted = residentIsDeleted(r);
    const disabled = residentIsDisabled(r);
    const safeName = String(r.name || "Resident")
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/"/g, "&quot;");

    let statusBadge;
    if (deleted) {
      statusBadge =
        '<span class="px-2 py-0.5 rounded text-xs font-bold bg-slate-200 text-slate-700"><i class="fa-solid fa-box-archive mr-1"></i>Deleted</span>';
    } else if (disabled) {
      statusBadge =
        '<span class="badge-danger px-2 py-0.5 rounded text-xs font-bold"><i class="fa-solid fa-ban mr-1"></i>Disabled</span>';
    } else if (r.isOnline) {
      statusBadge =
        '<span class="badge-success px-2 py-0.5 rounded text-xs font-bold">Online</span>';
    } else {
      statusBadge =
        '<span class="px-2 py-0.5 rounded text-xs font-bold bg-slate-100 text-slate-600">Offline</span>';
    }

    let subLine = "";
    if (deleted) {
      const when = r.deletedAt ? formatFirebaseTimestamp(r.deletedAt) : "";
      subLine = `<div class="text-[11px] text-slate-500 mt-1"><i class="fa-solid fa-clock-rotate-left mr-1"></i>Deleted${r.deletedBy ? ` by ${r.deletedBy}` : ""}${when ? ` on ${when}` : ""}</div>`;
    } else if (disabled && r.disabledReason) {
      subLine = `<div class="text-[11px] text-rose-500 mt-1"><i class="fa-solid fa-circle-info mr-1"></i>${r.disabledReason}</div>`;
    }

    let actions;
    if (deleted) {
      actions = `<button onclick="event.stopPropagation(); restoreResident('${id}','${safeName}')" class="text-xs font-bold text-emerald-700 bg-emerald-50 px-3 py-1.5 rounded-lg hover:bg-emerald-600 hover:text-white transition-colors"><i class="fa-solid fa-rotate-left mr-1"></i>Restore</button><button onclick="event.stopPropagation(); permanentlyDeleteResident('${id}','${safeName}')" class="text-xs font-bold text-rose-600 bg-rose-50 px-3 py-1.5 rounded-lg hover:bg-rose-600 hover:text-white transition-colors" title="Permanently erase - cannot be undone"><i class="fa-solid fa-trash-can"></i></button>`;
    } else {
      const toggleBtn = disabled
        ? `<button onclick="event.stopPropagation(); openResidentStatusModal('${id}','enable')" class="text-xs font-bold text-emerald-700 bg-emerald-50 px-3 py-1.5 rounded-lg hover:bg-emerald-600 hover:text-white transition-colors"><i class="fa-solid fa-circle-check mr-1"></i>Enable</button>`
        : `<button onclick="event.stopPropagation(); openResidentStatusModal('${id}','disable')" class="text-xs font-bold text-rose-600 bg-rose-50 px-3 py-1.5 rounded-lg hover:bg-rose-600 hover:text-white transition-colors"><i class="fa-solid fa-ban mr-1"></i>Disable</button>`;
      actions = `${toggleBtn}<button onclick="event.stopPropagation(); deleteResident('${id}','${safeName}')" class="text-xs font-bold text-slate-500 bg-slate-100 px-3 py-1.5 rounded-lg hover:bg-slate-700 hover:text-white transition-colors" title="Move to Deleted (recoverable)"><i class="fa-solid fa-box-archive"></i></button>`;
    }

    const rowTint = deleted
      ? "bg-slate-50 opacity-75"
      : disabled
        ? "bg-rose-50/40"
        : "";
    const nameStyle = deleted
      ? "text-slate-500 italic"
      : disabled
        ? "text-slate-500 line-through"
        : "";
    // Archived rows are not editable - restore first.
    const rowClick = deleted ? "" : `onclick="openResidentEdit('${id}')"`;

    h += `<tr class="hover:bg-blue-50/60 border-b transition-colors ${deleted ? "" : "cursor-pointer"} ${rowTint}" ${rowClick}><td class="px-5 py-4"><div class="font-bold ${nameStyle}">${r.name || "N/A"}</div><div class="text-xs text-stone-500">${r.phone || "No contact"}</div></td><td class="px-5 py-4 text-sm">${r.address || "N/A"}</td><td class="px-5 py-4">${statusBadge}${subLine}</td><td class="px-5 py-4 text-right" onclick="event.stopPropagation()"><div class="flex items-center justify-end gap-2">${actions}</div></td></tr>`;
  });
  tbody.innerHTML = h;
}

window.filterResidents = renderResidents;

window.openResidentStatusModal = function (id, action = "disable") {
  const r = allResidents.find((x) => x.id === id);
  if (!r) {
    window.showAdminAlert("Error", "Resident not found.", false);
    return;
  }
  const disabling = action !== "enable";

  document.getElementById("resident-status-id").value = id;
  document.getElementById("resident-status-action").value = disabling
    ? "disable"
    : "enable";
  document.getElementById("resident-status-name").textContent =
    r.name || "Unnamed resident";
  document.getElementById("resident-status-contact").textContent =
    [r.phone, r.email].filter(Boolean).join(" · ") || "No contact on file";

  document.getElementById("resident-status-heading").textContent = disabling
    ? "Disable Account"
    : "Re-enable Account";

  const reasonWrap = document.getElementById("resident-status-reason-wrap");
  if (reasonWrap) reasonWrap.classList.toggle("hidden", !disabling);
  const notes = document.getElementById("resident-status-notes");
  if (notes) notes.value = "";
  const reason = document.getElementById("resident-status-reason");
  if (reason) reason.value = "Suspicious activity";

  const warn = document.getElementById("resident-status-warning");
  if (warn) {
    warn.className = disabling
      ? "text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl p-3 leading-relaxed"
      : "text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl p-3 leading-relaxed";
    warn.innerHTML = disabling
      ? '<i class="fa-solid fa-triangle-exclamation mr-1"></i>A disabled resident can no longer log in, join events, volunteer, or send donations. They will be notified about this action.'
      : `<i class="fa-solid fa-circle-check mr-1"></i>This will restore full portal access.${r.disabledReason ? ` Previously disabled for: ${r.disabledReason}.` : ""}`;
  }

  const submit = document.getElementById("resident-status-submit");
  if (submit) {
    submit.className = disabling
      ? "px-5 py-2.5 rounded-xl text-sm font-bold shadow-md bg-rose-600 text-white hover:bg-rose-700 transition-colors"
      : "px-5 py-2.5 rounded-xl text-sm font-bold shadow-md bg-emerald-600 text-white hover:bg-emerald-700 transition-colors";
    submit.innerHTML = disabling
      ? '<i class="fa-solid fa-ban mr-1"></i> Disable Account'
      : '<i class="fa-solid fa-circle-check mr-1"></i> Enable Account';
  }

  window.toggleModal("resident-status-modal");
};

// Residents authenticate with Firebase Authentication, so the "password"
// field in Firestore is only a mirror that user.js re-syncs on every login.
// Never touch it here - it is not the login gate and editing it would be
// overwritten anyway. The real gate is the isDisabled flag, which user.js
// checks on login and in a live watcher.
//
// We also rotate sessionToken to a revoked value: the existing heartbeat in
// user.js already signs a resident out when the stored token stops matching
// theirs, so a disabled resident is kicked within ~30s even on an old build.
function revokedSessionToken() {
  return `REVOKED_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function handleResidentStatusSubmit(e) {
  e.preventDefault();
  const id = document.getElementById("resident-status-id")?.value;
  const action =
    document.getElementById("resident-status-action")?.value || "disable";
  if (!id) {
    window.showAdminAlert("Error", "No resident selected.", false);
    return;
  }
  const disabling = action === "disable";
  const picked =
    document.getElementById("resident-status-reason")?.value || "Other";
  const notes =
    document.getElementById("resident-status-notes")?.value.trim() || "";
  const reason = disabling
    ? picked === "Other"
      ? notes || "Violation of portal rules"
      : notes
        ? `${picked} - ${notes}`
        : picked
    : "";

  window.showLoading();
  try {
    const ref = doc(db, "residents", id);
    const snapshot = await getDoc(ref);
    if (!snapshot.exists()) {
      window.showAdminAlert("Error", "Resident not found.", false);
      return;
    }

    if (disabling) {
      await updateDoc(ref, {
        accountStatus: "Disabled",
        isDisabled: true,
        isOnline: false,
        // Invalidate any live session so the heartbeat logs them straight out.
        sessionToken: revokedSessionToken(),
        disabledReason: reason,
        disabledBy: getAdminDisplayName(),
        disabledById: loggedInAdmin?.id || "system",
        disabledAt: serverTimestamp(),
        enabledBy: null,
        enabledAt: null,
      });

      await revokeResidentPendingRecords(id);

      await createNotification(
        id,
        "Account Disabled",
        `Your Victoria Civic Portal account has been disabled. Reason: ${reason}. Please contact the municipal office if you believe this is a mistake.`,
        "account_disabled",
      );
      window.showAdminAlert(
        "Success",
        "Account disabled. The resident has been signed out and can no longer log in.",
        true,
      );
    } else {
      await updateDoc(ref, {
        accountStatus: "Active",
        isDisabled: false,
        disabledReason: "",
        sessionToken: null,
        enabledBy: getAdminDisplayName(),
        enabledById: loggedInAdmin?.id || "system",
        enabledAt: serverTimestamp(),
      });

      await createNotification(
        id,
        "Account Re-enabled",
        "Good news! Your Victoria Civic Portal account has been restored. You may now log in and join activities again.",
        "account_enabled",
      );
      window.showAdminAlert("Success", "Account re-enabled.", true);
    }
    window.toggleModal("resident-status-modal");
  } catch (err) {
    window.showAdminAlert("Error", err.message, false);
  } finally {
    window.hideLoading();
  }
}

// Withdraw a disabled resident from things that are still awaiting action.
//
// IMPORTANT: donations are deliberately left ALONE here.
//   - Approved donations stay on the public donation wall. The resident may be
//     barred from the portal, but the barangay still received that money or
//     goods, and the public record of it must remain intact.
//   - Pending donations are NOT auto-rejected either: the funds may already
//     have been sent, so only a human should decide. They stay in the admin
//     queue for normal review.
// Only the volunteer queue is withdrawn, because an unreviewed application
// from a barred account should not stay in line for a slot.
async function revokeResidentPendingRecords(residentId) {
  try {
    const batch = writeBatch(db);
    let touched = 0;

    const pendingVolunteers = await getDocs(
      query(
        collection(db, "volunteers"),
        where("residentId", "==", residentId),
        where("status", "==", STATUS.PENDING),
      ),
    );
    pendingVolunteers.forEach((d) => {
      batch.update(d.ref, {
        status: STATUS.REJECTED,
        adminNotes: "Auto-withdrawn: resident account disabled.",
        updatedAt: serverTimestamp(),
      });
      touched++;
    });

    if (touched) await batch.commit();
  } catch (err) {
    // Non-fatal: the account is already locked even if cleanup fails.
    console.error("Failed to withdraw pending records:", err);
  }
}

window.openResidentEdit = async function (id) {
  window.showLoading();
  try {
    const s = await getDoc(doc(db, "residents", id));
    if (!s.exists()) {
      window.hideLoading();
      window.showAdminAlert("Error", "Not found.", false);
      return;
    }
    const r = s.data();
    selectedResidentId = id;
    document.getElementById("edit-resident-name").value = r.name || "";
    document.getElementById("edit-resident-phone").value = r.phone || "";
    document.getElementById("edit-resident-age").value = r.age || "";
    document.getElementById("edit-resident-gender").value = r.gender || "Male";
    document.getElementById("edit-resident-address").value = r.address || "";
    window.toggleModal("resident-edit-modal");
  } catch (err) {
    window.showAdminAlert("Error", "Failed to load.", false);
  } finally {
    window.hideLoading();
  }
};
async function handleResidentEdit(e) {
  e.preventDefault();
  if (!selectedResidentId) {
    window.showAdminAlert("Error", "No resident selected.", false);
    return;
  }
  const n = document.getElementById("edit-resident-name")?.value.trim();
  if (!n) {
    window.showAdminAlert("Error", "Name required.", false);
    return;
  }
  window.showLoading();
  try {
    await updateDoc(doc(db, "residents", selectedResidentId), {
      name: n,
      phone: document.getElementById("edit-resident-phone")?.value.trim() || "",
      age:
        parseInt(document.getElementById("edit-resident-age")?.value.trim()) ||
        0,
      gender: document.getElementById("edit-resident-gender")?.value || "Male",
      address:
        document.getElementById("edit-resident-address")?.value.trim() || "",
      lastModifiedBy: getAdminDisplayName(),
      lastModifiedById: loggedInAdmin?.id || "system",
      lastModifiedAt: serverTimestamp(),
    });
    window.toggleModal("resident-edit-modal");
    selectedResidentId = null;
    window.showAdminAlert("Success", "Updated!", true);
  } catch (err) {
    window.showAdminAlert("Error", err.message, false);
  } finally {
    window.hideLoading();
  }
}
// SOFT DELETE.
//
// A resident who is deleted can later ask the municipal office to recover the
// account, so we must never destroy the profile document - once it is gone,
// nothing can bring it back. Instead we archive it: the row disappears from
// the normal registry, the resident cannot log in, but an admin can restore
// everything from the "Deleted (recoverable)" filter.
//
// Their queue entries (participants / volunteers) are archived alongside it so
// a deleted resident does not keep occupying event slots while archived.
// Donations are never touched at all - that ledger is a public record.
window.deleteResident = function (id, name) {
  window.showConfirmPopup(
    "Delete Resident?",
    `Archive "${name}"? They will lose portal access immediately. The account is kept in "Deleted (recoverable)" so you can restore it if the resident requests recovery. Donation records are always preserved.`,
    async () => {
      window.showLoading();
      try {
        const batch = writeBatch(db);

        // 1. Archive the profile itself - NEVER delete the document.
        batch.update(doc(db, "residents", id), {
          isDeleted: true,
          accountStatus: "Deleted",
          isOnline: false,
          // Kill any live session: the user.js heartbeat signs them out.
          sessionToken: `REVOKED_${Date.now()}`,
          deletedBy: getAdminDisplayName(),
          deletedById: loggedInAdmin?.id || "system",
          deletedAt: serverTimestamp(),
          restoredBy: null,
          restoredAt: null,
        });

        // 2. Archive queue entries so slots are freed, but keep them for restore.
        const participants = await getDocs(
          query(collection(db, "participants"), where("residentId", "==", id)),
        );
        participants.forEach((d) => {
          batch.update(d.ref, {
            archivedWithResident: true,
            archivedAt: serverTimestamp(),
          });
        });

        const volunteers = await getDocs(
          query(collection(db, "volunteers"), where("residentId", "==", id)),
        );
        volunteers.forEach((d) => {
          batch.update(d.ref, {
            archivedWithResident: true,
            archivedAt: serverTimestamp(),
          });
        });

        // 3. Donations are deliberately untouched - public transparency ledger.

        await batch.commit();
        window.showAdminAlert(
          "Archived",
          `"${name}" moved to Deleted accounts. You can restore this account anytime.`,
          true,
        );
      } catch (err) {
        window.showAdminAlert("Error", err.message, false);
      } finally {
        window.hideLoading();
      }
    },
  );
};

// Bring an archived resident back after they request account recovery.
window.restoreResident = function (id, name) {
  window.showConfirmPopup(
    "Restore Account?",
    `Restore "${name}"? They will be able to log in again and their event and volunteer records will be reinstated.`,
    async () => {
      window.showLoading();
      try {
        const batch = writeBatch(db);

        // The account comes back ACTIVE. If it also needs to stay disabled for
        // misconduct, the admin can disable it separately afterwards.
        batch.update(doc(db, "residents", id), {
          isDeleted: false,
          accountStatus: "Active",
          isDisabled: false,
          disabledReason: "",
          sessionToken: null,
          restoredBy: getAdminDisplayName(),
          restoredById: loggedInAdmin?.id || "system",
          restoredAt: serverTimestamp(),
        });

        const participants = await getDocs(
          query(
            collection(db, "participants"),
            where("residentId", "==", id),
            where("archivedWithResident", "==", true),
          ),
        );
        participants.forEach((d) => {
          batch.update(d.ref, {
            archivedWithResident: false,
            restoredAt: serverTimestamp(),
          });
        });

        const volunteers = await getDocs(
          query(
            collection(db, "volunteers"),
            where("residentId", "==", id),
            where("archivedWithResident", "==", true),
          ),
        );
        volunteers.forEach((d) => {
          batch.update(d.ref, {
            archivedWithResident: false,
            restoredAt: serverTimestamp(),
          });
        });

        await batch.commit();

        await createNotification(
          id,
          "Account Restored",
          "Your Victoria Civic Portal account has been recovered by the municipal office. You may now log in again.",
          "account_restored",
        );

        window.showAdminAlert(
          "Restored",
          `"${name}" can now log in again.`,
          true,
        );
      } catch (err) {
        window.showAdminAlert("Error", err.message, false);
      } finally {
        window.hideLoading();
      }
    },
  );
};

// Irreversible removal, only reachable from the Deleted filter. This is the
// only path that truly destroys a profile, and it still preserves donations.
window.permanentlyDeleteResident = function (id, name) {
  window.showConfirmPopup(
    "Permanently Delete?",
    `This CANNOT be undone. "${name}" will be erased and can never be recovered. Their donation records will still be kept for transparency. Continue?`,
    async () => {
      window.showLoading();
      try {
        const batch = writeBatch(db);
        batch.delete(doc(db, "residents", id));

        const participants = await getDocs(
          query(collection(db, "participants"), where("residentId", "==", id)),
        );
        participants.forEach((d) => batch.delete(d.ref));

        const volunteers = await getDocs(
          query(collection(db, "volunteers"), where("residentId", "==", id)),
        );
        volunteers.forEach((d) => batch.delete(d.ref));

        // Detach but PRESERVE the donation ledger.
        const donations = await getDocs(
          query(collection(db, "donations"), where("donorId", "==", id)),
        );
        donations.forEach((d) => {
          batch.update(d.ref, {
            donorId: null,
            donorAccountDeleted: true,
            donorName: d.data().donorName || name || "Former resident",
            updatedAt: serverTimestamp(),
          });
        });

        await batch.commit();
        window.showAdminAlert(
          "Permanently Deleted",
          `"${name}" erased. ${donations.size} donation record(s) preserved.`,
          true,
        );
      } catch (err) {
        window.showAdminAlert("Error", err.message, false);
      } finally {
        window.hideLoading();
      }
    },
  );
};

window.updateVolunteerStatus = async function (id, ns) {
  window.showLoading();
  try {
    const s = await getDoc(doc(db, "volunteers", id));
    if (!s.exists()) {
      window.hideLoading();
      window.showAdminAlert("Error", "Not found.", false);
      return;
    }
    const d = s.data();
    await updateDoc(doc(db, "volunteers", id), {
      status: ns,
      reviewedBy: getAdminDisplayName(),
      reviewedById: loggedInAdmin?.id || "system",
      reviewedAt: serverTimestamp(),
    });
    if (d.residentId) {
      const sm =
        ns === STATUS.APPROVED
          ? "approved"
          : ns === STATUS.REJECTED
            ? "rejected"
            : "reset";
      await createNotification(
        d.residentId,
        `Volunteer ${sm}`,
        `Application ${sm} by ${getAdminDisplayName()}.`,
        ns === STATUS.APPROVED
          ? "volunteer_approved"
          : ns === STATUS.REJECTED
            ? "volunteer_rejected"
            : "general",
      );
    }
    window.showAdminAlert("Success", `Volunteer ${ns.toLowerCase()}!`, true);
  } catch (err) {
    window.showAdminAlert("Error", "Failed.", false);
  } finally {
    window.hideLoading();
  }
};
window.rejectServiceHours = async function (id) {
  window.showConfirmPopup("Reject Hours?", "Mark as rejected?", async () => {
    window.showLoading();
    try {
      const s = await getDoc(doc(db, "service_hours", id));
      if (!s.exists()) {
        window.hideLoading();
        window.showAdminAlert("Error", "Not found.", false);
        return;
      }
      const d = s.data();
      await updateDoc(doc(db, "service_hours", id), {
        status: STATUS.REJECTED,
        rejectedBy: getAdminDisplayName(),
        rejectedById: loggedInAdmin?.id || "system",
        rejectedAt: serverTimestamp(),
      });
      if (d.residentId)
        await createNotification(
          d.residentId,
          "Hours Rejected",
          `${d.hours || 0} hours rejected by ${getAdminDisplayName()}.`,
          "hours_rejected",
        );
      window.showAdminAlert("Success", "Rejected.", true);
    } catch (err) {
      window.showAdminAlert("Error", err.message, false);
    } finally {
      window.hideLoading();
    }
  });
};
window.restoreServiceHours = async function (id) {
  window.showConfirmPopup("Restore Hours?", "Restore?", async () => {
    window.showLoading();
    try {
      const s = await getDoc(doc(db, "service_hours", id));
      if (!s.exists()) {
        window.hideLoading();
        window.showAdminAlert("Error", "Not found.", false);
        return;
      }
      const d = s.data();
      await updateDoc(doc(db, "service_hours", id), {
        status: STATUS.APPROVED,
        restoredBy: getAdminDisplayName(),
        restoredById: loggedInAdmin?.id || "system",
        restoredAt: serverTimestamp(),
      });
      if (d.residentId)
        await createNotification(
          d.residentId,
          "Hours Restored",
          `${d.hours || 0} hours restored by ${getAdminDisplayName()}.`,
          "hours_restored",
        );
      window.showAdminAlert("Success", "Restored.", true);
    } catch (err) {
      window.showAdminAlert("Error", err.message, false);
    } finally {
      window.hideLoading();
    }
  });
};
window.bulkApproveVolunteers = async function () {
  window.showConfirmPopup("Bulk Approve?", "Approve ALL pending?", async () => {
    window.showLoading();
    try {
      const s = await getDocs(
        query(
          collection(db, "volunteers"),
          where("status", "==", STATUS.PENDING),
        ),
      );
      if (s.empty) {
        window.hideLoading();
        window.showAdminAlert("Info", "No pending.", true);
        return;
      }
      const b = writeBatch(db);
      const n = [];
      s.forEach((d) => {
        const data = d.data();
        b.update(d.ref, {
          status: STATUS.APPROVED,
          reviewedBy: getAdminDisplayName(),
          reviewedById: loggedInAdmin?.id || "system",
          reviewedAt: serverTimestamp(),
        });
        if (data.residentId)
          n.push({
            residentId: data.residentId,
            title: "Volunteer Approved",
            message: `Approved by ${getAdminDisplayName()}.`,
            type: "volunteer_approved",
          });
      });
      await b.commit();
      for (const notif of n)
        await createNotification(
          notif.residentId,
          notif.title,
          notif.message,
          notif.type,
        );
      window.showAdminAlert("Success", `Approved ${s.size} volunteers!`, true);
    } catch (err) {
      window.showAdminAlert("Error", err.message, false);
    } finally {
      window.hideLoading();
    }
  });
};
window.updateDonationStatus = async function (id, ns) {
  window.showLoading();
  try {
    const s = await getDoc(doc(db, "donations", id));
    if (!s.exists()) {
      window.hideLoading();
      window.showAdminAlert("Error", "Not found.", false);
      return;
    }
    const d = s.data();
    await updateDoc(doc(db, "donations", id), {
      status: ns,
      // REJECTION FIX: keep paymentStatus in sync so the resident's
      // history (which may read either field) updates immediately.
      paymentStatus: ns,
      reviewedBy: getAdminDisplayName(),
      reviewedById: loggedInAdmin?.id || "system",
      reviewedAt: serverTimestamp(),
    });
    if (d.donorId) {
      const sm =
        ns === STATUS.APPROVED
          ? "confirmed"
          : ns === STATUS.REJECTED
            ? "rejected"
            : "reset";
      await createNotification(
        d.donorId,
        `Donation ${sm}`,
        `Donation ${sm} by ${getAdminDisplayName()}.`,
        ns === STATUS.APPROVED
          ? "donation_confirmed"
          : ns === STATUS.REJECTED
            ? "donation_rejected"
            : "general",
      );
    }
    window.showAdminAlert("Success", `Donation ${ns.toLowerCase()}!`, true);
  } catch (err) {
    window.showAdminAlert("Error", "Failed.", false);
  } finally {
    window.hideLoading();
  }
};
async function resolveFeedbackResidentId(message) {
  if (message?.residentId) return message.residentId;
  const email = String(message?.email || message?.residentEmail || "")
    .trim()
    .toLowerCase();
  if (!email) return null;
  try {
    const snap = await getDocs(
      query(collection(db, "residents"), where("email", "==", email), limit(1)),
    );
    if (snap.empty) return null;
    return snap.docs[0].id;
  } catch (e) {
    return null;
  }
}

window.updateContactStatus = async function (id, ns) {
  window.showLoading();
  try {
    const s = await getDoc(doc(db, "contact_messages", id));
    if (!s.exists()) {
      window.hideLoading();
      window.showAdminAlert("Error", "Not found.", false);
      return;
    }
    const m = s.data();
    const residentId = await resolveFeedbackResidentId(m);
    const patch = {
      status: ns,
      reviewedBy: getAdminDisplayName(),
      reviewedById: loggedInAdmin?.id || "system",
      reviewedAt: serverTimestamp(),
    };
    if (residentId && !m.residentId) patch.residentId = residentId;
    await updateDoc(doc(db, "contact_messages", id), patch);

    if (residentId) {
      const subject = m.subject || "your feedback";
      const ref = m.referenceNumber ? ` (${m.referenceNumber})` : "";
      const titles = {
        Resolved: "Feedback resolved",
        "In Progress": "Feedback in progress",
        Closed: "Feedback closed",
        Pending: "Feedback pending again",
      };
      const bodies = {
        Resolved: `Your feedback “${subject}”${ref} was marked Resolved by municipal staff. Thank you for writing to OneVictoria.`,
        "In Progress": `Your feedback “${subject}”${ref} is now In Progress. Staff are reviewing it.`,
        Closed: `Your feedback “${subject}”${ref} was Closed by municipal staff.`,
        Pending: `Your feedback “${subject}”${ref} was set back to Pending.`,
      };
      await createNotification(
        residentId,
        titles[ns] || `Feedback: ${ns}`,
        bodies[ns] || `Status of “${subject}” is now ${ns}.`,
        "feedback_status",
      );
    }
    window.showAdminAlert(
      "Success",
      residentId
        ? `Feedback marked ${ns}. The resident was notified.`
        : `Feedback marked ${ns}. No matching resident account, so no in-app notification was sent.`,
      true,
    );
  } catch (err) {
    window.showAdminAlert("Error", err.message, false);
  } finally {
    window.hideLoading();
  }
};
function escapeAdminHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function feedbackStarsHtml(rating) {
  const n = parseInt(rating, 10) || 0;
  if (!n) return "";
  const labels = ["", "Very poor", "Poor", "Average", "Good", "Excellent"];
  let stars = "";
  for (let i = 1; i <= 5; i++) {
    stars += `<i class="fa-solid fa-star ${i <= n ? "text-victoria-gold" : "text-slate-200"}"></i>`;
  }
  return `<div class="flex items-center gap-1.5 text-sm">${stars}<span class="text-xs font-semibold text-slate-500 ml-1">${n}/5 ${labels[n] || ""}</span></div>`;
}

window.viewContactMessage = async function (id) {
  window.showLoading();
  try {
    const s = await getDoc(doc(db, "contact_messages", id));
    if (!s.exists()) {
      window.hideLoading();
      window.showAdminAlert("Error", "Not found.", false);
      return;
    }
    const m = s.data();
    let attachments = Array.isArray(m.attachments) ? m.attachments : [];
    if (!attachments.length) {
      try {
        const attSnap = await getDocs(
          collection(db, "contact_messages", id, "attachments"),
        );
        attachments = attSnap.docs.map((d) => d.data());
      } catch (e) { }
    }

    let ah = "";
    if (attachments.length) {
      const tiles = attachments
        .map((f, i) => {
          const isImg =
            String(f.fileType || "").startsWith("image/") ||
            String(f.data || "").startsWith("data:image/");
          const name = escapeAdminHtml(f.fileName || `File ${i + 1}`);
          if (isImg && f.data) {
            return `<div class="rounded-xl overflow-hidden border border-slate-200 bg-slate-50">
              <img src="${f.data}" alt="${name}" class="w-full max-h-56 object-contain bg-white">
              <div class="flex items-center justify-between px-2 py-1.5 text-[11px]">
                <span class="truncate font-medium text-slate-600">${name}</span>
                <button onclick="downloadAttachment('${id}',${i})" class="text-victoria-blue font-bold">Download</button>
              </div>
            </div>`;
          }
          return `<div class="flex items-center justify-between bg-gray-50 p-2 rounded-lg"><span class="text-xs"><i class="fa-solid fa-paperclip mr-1.5 text-victoria-blue"></i>${name}</span><button onclick="downloadAttachment('${id}',${i})" class="text-xs bg-victoria-blue text-white px-2 py-1 rounded">Download</button></div>`;
        })
        .join("");
      ah = `<div class="mt-1"><h4 class="text-sm font-bold mb-2">Screenshots / files (${attachments.length})</h4><div class="grid grid-cols-1 sm:grid-cols-2 gap-2">${tiles}</div></div>`;
    }

    const pb =
      m.priority === "Urgent"
        ? "badge-danger"
        : m.priority === "High"
          ? "badge-warning"
          : m.priority === "Medium"
            ? "badge-info"
            : "badge-success";
    const typeLabel = escapeAdminHtml(
      m.feedbackType || m.serviceCategory || "Feedback",
    );
    const modal = document.createElement("div");
    modal.className =
      "fixed inset-0 bg-gray-900/80 backdrop-blur-sm flex items-center justify-center p-4 z-[180]";
    modal.id = "contact-message-viewer";
    modal.onclick = function (e) {
      if (e.target === this) this.remove();
    };
    modal.innerHTML = `<div class="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl border modal-enter"><div class="p-6"><div class="flex items-center justify-between mb-4"><div><h3 class="text-lg font-extrabold text-victoria-blue">Feedback details</h3><p class="text-xs text-stone-500">Ref: ${escapeAdminHtml(m.referenceNumber || "N/A")}</p></div><button onclick="document.getElementById('contact-message-viewer').remove()" class="text-gray-400 hover:text-gray-600 p-2"><i class="fa-solid fa-xmark text-xl"></i></button></div><div class="space-y-3 mb-4"><div class="flex flex-wrap items-center gap-2"><span class="px-2 py-0.5 rounded text-xs font-bold ${m.status === "Resolved" ? "badge-success" : m.status === "In Progress" ? "badge-info" : m.status === "Closed" ? "badge-danger" : "badge-warning"}">${escapeAdminHtml(m.status || "Pending")}</span><span class="px-2 py-0.5 rounded text-xs font-bold ${pb}">${escapeAdminHtml(m.priority || "Medium")}</span><span class="px-2 py-0.5 rounded text-xs font-bold bg-victoria-light text-victoria-blue">${typeLabel}</span></div>${feedbackStarsHtml(m.rating)}<div class="grid grid-cols-2 gap-3 text-sm"><div><span class="font-semibold">From:</span> ${escapeAdminHtml(m.fullName || "N/A")}</div><div><span class="font-semibold">Email:</span> ${escapeAdminHtml(m.email || "N/A")}</div><div><span class="font-semibold">Phone:</span> ${escapeAdminHtml(m.phone || "N/A")}</div><div><span class="font-semibold">Type:</span> ${typeLabel}</div>${m.address ? `<div class="col-span-2"><span class="font-semibold">Address:</span> ${escapeAdminHtml(m.address)}</div>` : ""}</div><div class="bg-gray-50 p-3 rounded-lg"><p class="text-xs font-semibold mb-1">Subject</p><p class="text-sm font-bold">${escapeAdminHtml(m.subject || "N/A")}</p></div><div class="bg-gray-50 p-3 rounded-lg"><p class="text-xs font-semibold mb-1">Feedback</p><p class="text-sm whitespace-pre-line">${escapeAdminHtml(m.message || "N/A")}</p></div>${ah}<div class="text-xs text-stone-400">Received: ${m.createdAt ? formatFirebaseTimestamp(m.createdAt) : "N/A"}</div></div><div class="flex space-x-3">${m.status !== "Resolved" ? `<button onclick="updateContactStatus('${id}','Resolved');document.getElementById('contact-message-viewer').remove()" class="flex-1 bg-emerald-600 text-white font-semibold py-2.5 rounded-xl text-sm hover:bg-emerald-700"><i class="fa-solid fa-check mr-1.5"></i>Mark Resolved</button>` : ""}${m.status !== "In Progress" ? `<button onclick="updateContactStatus('${id}','In Progress');document.getElementById('contact-message-viewer').remove()" class="flex-1 bg-amber-600 text-white font-semibold py-2.5 rounded-xl text-sm hover:bg-amber-700"><i class="fa-solid fa-spinner mr-1.5"></i>In Progress</button>` : ""}${m.status !== "Closed" ? `<button onclick="updateContactStatus('${id}','Closed');document.getElementById('contact-message-viewer').remove()" class="flex-1 bg-red-600 text-white font-semibold py-2.5 rounded-xl text-sm hover:bg-red-700"><i class="fa-solid fa-lock mr-1.5"></i>Mark Closed</button>` : ""}</div></div></div>`;
    document.body.appendChild(modal);
    window.hideLoading();
  } catch (err) {
    window.hideLoading();
    window.showAdminAlert("Error", "Failed to load.", false);
  }
};
window.downloadAttachment = async function (id, idx) {
  try {
    const s = await getDoc(doc(db, "contact_messages", id));
    if (!s.exists()) {
      window.showAdminAlert("Error", "Not found.", false);
      return;
    }
    const m = s.data();
    let attachments = Array.isArray(m.attachments) ? m.attachments : [];
    if (!attachments.length) {
      const attSnap = await getDocs(
        collection(db, "contact_messages", id, "attachments"),
      );
      attachments = attSnap.docs.map((d) => d.data());
    }
    if (!attachments[idx]?.data) {
      window.showAdminAlert("Error", "Attachment not found.", false);
      return;
    }
    const f = attachments[idx];
    const l = document.createElement("a");
    l.href = f.data;
    l.download = f.fileName || "feedback-file";
    document.body.appendChild(l);
    l.click();
    document.body.removeChild(l);
  } catch (err) {
    window.showAdminAlert("Error", "Download failed.", false);
  }
};
window.deleteContactMessage = function (id, name) {
  window.showConfirmPopup(
    "Delete Message?",
    `Delete from "${name}"?`,
    async () => {
      window.showLoading();
      try {
        await deleteDoc(doc(db, "contact_messages", id));
        window.showAdminAlert("Success", "Deleted.", true);
      } catch (err) {
        window.showAdminAlert("Error", err.message, false);
      } finally {
        window.hideLoading();
      }
    },
  );
};
function initContactMessagesListener() {
  const tbody = document.getElementById("contact-messages-tbody"),
    es = document.getElementById("contact-empty-state");
  const tc = document.getElementById("contact-total-count"),
    pc = document.getElementById("contact-pending-count"),
    ipc = document.getElementById("contact-progress-count"),
    rc = document.getElementById("contact-resolved-count");
  if (!tbody) return;
  onSnapshot(
    query(collection(db, "contact_messages"), orderBy("createdAt", "desc")),
    (snap) => {
      let t = 0,
        p = 0,
        ip = 0,
        r = 0,
        c = 0;
      allContactMessages = [];
      snap.forEach((d) => {
        const m = d.data();
        allContactMessages.push({ id: d.id, ...m });
        t++;
        if (m.status === "Pending") p++;
        else if (m.status === "In Progress") ip++;
        else if (m.status === "Resolved") r++;
        else if (m.status === "Closed") c++;
      });
      if (tc) tc.textContent = t;
      if (pc) pc.textContent = p;
      if (ipc) ipc.textContent = ip;
      if (rc) rc.textContent = r + c;
      refreshActionBadges();
      if (snap.empty) {
        tbody.innerHTML = "";
        if (es) es.classList.remove("hidden");
        return;
      }
      if (es) es.classList.add("hidden");
      let h = "";
      snap.forEach((d) => {
        const m = d.data(),
          id = d.id;
        let sb = "";
        if (m.status === "Resolved")
          sb =
            '<span class="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-700"><i class="fa-solid fa-circle-check mr-1 text-[9px]"></i>Resolved</span>';
        else if (m.status === "In Progress")
          sb =
            '<span class="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold bg-blue-100 text-blue-700"><i class="fa-solid fa-spinner mr-1 text-[9px]"></i>In Progress</span>';
        else if (m.status === "Closed")
          sb =
            '<span class="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold bg-gray-100 text-gray-600"><i class="fa-solid fa-lock mr-1 text-[9px]"></i>Closed</span>';
        else
          sb =
            '<span class="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold bg-amber-100 text-amber-700"><i class="fa-solid fa-clock mr-1 text-[9px]"></i>Pending</span>';
        let prb = "";
        if (m.priority === "Urgent")
          prb =
            '<span class="inline-flex items-center px-2 py-0.5 rounded text-[9px] font-bold bg-red-100 text-red-700"><i class="fa-solid fa-circle-exclamation mr-1 text-[8px]"></i>Urgent</span>';
        else if (m.priority === "High")
          prb =
            '<span class="inline-flex items-center px-2 py-0.5 rounded text-[9px] font-bold bg-orange-100 text-orange-700"><i class="fa-solid fa-arrow-up mr-1 text-[8px]"></i>High</span>';
        else if (m.priority === "Medium")
          prb =
            '<span class="inline-flex items-center px-2 py-0.5 rounded text-[9px] font-bold bg-blue-100 text-blue-700"><i class="fa-solid fa-minus mr-1 text-[8px]"></i>Medium</span>';
        else
          prb =
            '<span class="inline-flex items-center px-2 py-0.5 rounded text-[9px] font-bold bg-gray-100 text-gray-600"><i class="fa-solid fa-arrow-down mr-1 text-[8px]"></i>Low</span>';
        const ha =
          m.hasAttachments || (m.attachments && m.attachments.length > 0);
        const ac =
          m.attachmentCount || (m.attachments ? m.attachments.length : 0);
        const ai = ha
          ? `<span class="inline-flex items-center text-victoria-blue font-semibold" title="${ac} attachment(s)"><i class="fa-solid fa-paperclip mr-1"></i>${ac}</span>`
          : '<span class="text-gray-300">-</span>';
        const md = m.createdAt
          ? new Date(
            m.createdAt.toDate ? m.createdAt.toDate() : m.createdAt,
          ).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })
          : "N/A";
        const mt = m.createdAt
          ? new Date(
            m.createdAt.toDate ? m.createdAt.toDate() : m.createdAt,
          ).toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
          })
          : "";
        const mp =
          (m.message || "").length > 80
            ? (m.message || "").substring(0, 80) + "..."
            : m.message || "";
        const isNew = (m.status || "Pending") === "Pending";
        h += `<tr data-status="${m.status || 'Pending'}" class="${isNew ? "row-new " : ""}hover:bg-blue-50/60 border-b cursor-pointer transition-colors contact-message-row" onclick="viewContactMessage('${id}')"><td class="px-5 py-4"><div class="font-bold text-sm">${m.fullName || "Anonymous"}${isNew ? " " + newChipHtml() : ""}</div><div class="text-xs text-gray-500">${m.email || "N/A"}</div>${m.phone ? `<div class="text-xs text-gray-400"><i class="fa-solid fa-phone text-[10px] mr-1"></i>${m.phone}</div>` : ""}</td><td class="px-4 py-4"><div class="text-xs font-semibold mb-1.5">${m.serviceCategory || "General"}</div>${prb}</td><td class="px-4 py-4"><div class="text-sm font-semibold mb-1">${m.subject || "No Subject"}</div><div class="text-xs text-gray-500">${mp || "No content"}</div></td><td class="px-4 py-4"><div class="text-xs font-medium">${md}</div><div class="text-xs text-gray-400">${mt}</div></td><td class="px-4 py-4 text-center">${ai}</td><td class="px-2 py-4">${sb}</td></tr>`;
      });
      tbody.innerHTML = h;
      if (typeof window.filterContactMessages === "function") {
        window.filterContactMessages();
      }
    },
    (err) => {
      console.error("Contact listener error:", err);
      if (tbody)
        tbody.innerHTML = `<tr><td colspan="7" class="px-4 py-10 text-center text-red-400"><i class="fa-solid fa-triangle-exclamation text-2xl mb-3 block"></i>Error Loading Messages</td></tr>`;
    },
  );
}
window.triggerAdminLogoutConfirmation = function () {
  window.showConfirmPopup("Logout?", "Disconnect?", () => {
    window.showLoading();
    setTimeout(() => {
      clearAdminSession();
      loggedInAdmin = null;
      document.getElementById("login-screen")?.classList.remove("hidden");
      document.getElementById("dashboard")?.classList.add("hidden");
      document.getElementById("login-form")?.reset();
      window.hideLoading();
    }, 800);
  });
};
onSnapshot(
  query(collection(db, "announcements"), orderBy("createdAt", "desc")),
  (snap) => {
    const c = document.getElementById("announcements-container");
    if (!c) return;
    if (snap.empty) {
      c.innerHTML =
        '<div class="col-span-full text-center py-10 text-stone-400 bg-white border rounded-xl">No announcements yet.</div>';
      return;
    }
    let h = "";
    snap.forEach((d) => {
      const a = d.data(),
        id = d.id;
      const priority = a.priority || "Notice";
      const normalized = String(priority).toLowerCase();
      const theme =
        normalized === "emergency"
          ? {
            wrap: "border-rose-200 bg-rose-50/40",
            icon: "bg-rose-100 text-rose-700",
            badge: "bg-red-100 text-red-800",
            glyph: "fa-triangle-exclamation",
          }
          : normalized === "important"
            ? {
              wrap: "border-amber-200 bg-amber-50/40",
              icon: "bg-amber-100 text-amber-700",
              badge: "bg-amber-100 text-amber-800",
              glyph: "fa-circle-exclamation",
            }
            : {
              wrap: "border-slate-200 bg-white",
              icon: "bg-victoria-light text-victoria-blue",
              badge: "bg-stone-100 text-stone-800",
              glyph: "fa-bullhorn",
            };
      const annImg = (a.imageUrl || a.image || "").trim();
      const imgHtml = annImg
        ? `<div class="mt-2 rounded-lg overflow-hidden border border-slate-200 bg-slate-100 aspect-video"><img src="${annImg}" alt="${a.title || "Announcement"}" class="w-full h-full object-cover" loading="lazy" decoding="async"></div>`
        : "";
      h += `<div class="${theme.wrap} border p-4 rounded-2xl shadow-sm card flex flex-col h-full">
        <div class="flex items-start justify-between gap-3">
          <div class="${theme.icon} w-9 h-9 rounded-lg flex items-center justify-center shrink-0"><i class="fa-solid ${theme.glyph} text-sm"></i></div>
          <div class="flex items-center gap-1.5 shrink-0">
            <button onclick="openEditAnnouncement('${id}')" class="w-7 h-7 rounded-lg text-victoria-blue bg-victoria-light hover:bg-victoria-blue hover:text-white transition-colors" aria-label="Edit announcement" title="Edit announcement"><i class="fa-solid fa-pen-to-square text-xs"></i></button>
            <button onclick="deleteAnnouncement('${id}')" class="w-7 h-7 rounded-lg text-rose-600 bg-rose-50 hover:bg-rose-600 hover:text-white transition-colors" aria-label="Delete announcement" title="Delete announcement"><i class="fa-solid fa-trash text-xs"></i></button>
          </div>
        </div>
        <div class="flex items-center flex-wrap gap-2 mt-2">
          <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${theme.badge}">${priority}</span>
          <span class="text-[11px] text-slate-400"><i class="fa-solid fa-clock mr-1"></i>${formatFirebaseTimestamp(a.createdAt)}</span>
        </div>
        <h3 class="font-extrabold text-slate-900 text-sm mt-1.5 break-words line-clamp-2">${a.title || ""}</h3>
        ${imgHtml}
        <p class="text-xs text-slate-600 mt-2 leading-relaxed break-words line-clamp-3 flex-1">${a.desc || ""}</p>
        <p class="text-[11px] text-slate-400 mt-2 pt-2 border-t border-slate-200/70">Posted by: ${a.createdBy || "Admin"}${a.updatedAt ? ` · Edited by ${a.updatedBy || "Admin"} on ${formatFirebaseTimestamp(a.updatedAt)}` : ""}</p>
      </div>`;
    });
    c.innerHTML = h;
  },
);
let allEvents = [];
onSnapshot(query(collection(db, "events"), orderBy("date", "asc")), (snap) => {
  const g = document.getElementById("events-grid");
  if (!g) return;
  allEvents = [];
  if (snap.empty) {
    g.innerHTML =
      '<div class="col-span-full text-center py-10 text-stone-400 bg-white border rounded-xl">No events yet.</div>';
    return;
  }
  let h = "";
  snap.forEach((d) => {
    const e = d.data(),
      id = d.id;
    allEvents.push({ id, ...e });
    const et = (e.title || "").replace(/'/g, "\\'"),
      el = (e.location || "").replace(/'/g, "\\'"),
      ed = (e.desc || "").replace(/'/g, "\\'").replace(/\n/g, "<br>");
    const dd = e.date || "TBA",
      td = e.time ? formatTime(e.time) : "";
    const hi = e.imageUrl && e.imageUrl !== "";
    const is = hi
      ? `<div class="h-44 bg-slate-100 overflow-hidden"><img src="${e.imageUrl}" alt="${et}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" loading="lazy"></div>`
      : '<div class="h-36 bg-gradient-to-br from-victoria-dark via-victoria-blue to-victoria-accent flex items-center justify-center bg-pattern"><i class="fa-solid fa-calendar-day text-4xl text-white/70"></i></div>';
    h += `<div class="bg-white rounded-2xl border border-slate-200 shadow-sm hover:shadow-lg hover:border-victoria-blue/40 transition-all flex flex-col group card overflow-hidden min-h-[330px] cursor-pointer" onclick="openAdminEventDetails('${id}')">${is}<div class="p-5 flex flex-col flex-1"><span class="text-[10px] font-bold uppercase bg-victoria-light text-victoria-blue px-2.5 py-1 rounded-md mb-2 inline-block w-fit">${e.type || e.category || "Event"}</span><h3 class="text-base font-bold text-slate-900 group-hover:text-victoria-blue transition-colors line-clamp-2">${e.title || ""}</h3><p class="text-xs text-stone-500 mt-1"><i class="fa-solid fa-calendar mr-1"></i>${dd}${td ? ` <span class="ml-2"><i class="fa-solid fa-clock mr-1"></i>${td}</span>` : ""}</p><p class="text-xs text-stone-500 mt-1"><i class="fa-solid fa-location-dot mr-1"></i>${e.location || "TBA"}</p><p class="text-xs text-stone-400 mt-1">By: ${e.createdBy || "Admin"}</p><div class="flex items-center justify-end space-x-2 mt-auto pt-3 border-t border-slate-100"><button type="button" onclick="event.stopPropagation();openEditEventModal('${id}')" class="text-xs bg-amber-50 text-amber-600 font-bold py-2 px-3 rounded-lg hover:bg-amber-600 hover:text-white transition-all shadow-xs" title="Edit Event"><i class="fa-solid fa-edit mr-1"></i>Edit</button><button type="button" onclick="event.stopPropagation();deleteEvent('${id}')" class="text-xs bg-red-50 text-red-600 font-bold py-2 px-3 rounded-lg hover:bg-red-600 hover:text-white transition-all shadow-xs" title="Delete Event"><i class="fa-solid fa-trash mr-1"></i>Delete</button></div></div></div>`;
  });
  g.innerHTML = h;
});
window.openAdminEventDetails = function (idOrTitle, d, tm, l, desc) {
  let e = allEvents.find((x) => x.id === idOrTitle);
  let title = "", dateStr = "", timeStr = "", locStr = "", descStr = "", imgUrl = "";
  if (e) {
    title = e.title || "Untitled Event";
    dateStr = e.date || "TBA";
    timeStr = e.time ? formatTime(e.time) : "";
    locStr = e.location || "TBA";
    descStr = (e.desc || "No description provided.").replace(/\n/g, "<br>");
    imgUrl = (e.imageUrl || e.image || "").trim();
  } else {
    title = idOrTitle || "";
    dateStr = d || "TBA";
    timeStr = tm || "";
    locStr = l || "TBA";
    descStr = desc || "";
  }

  const mT = document.getElementById("admin-modal-event-title"),
    mD = document.getElementById("admin-modal-event-date"),
    mL = document.getElementById("admin-modal-event-location"),
    mDesc = document.getElementById("admin-modal-event-desc"),
    mImg = document.getElementById("admin-modal-event-img"),
    mImgWrap = document.getElementById("admin-modal-event-img-wrap");

  if (mT) mT.innerText = title;
  if (mD) mD.innerHTML = `<i class="fa-solid fa-calendar mr-2 text-victoria-blue"></i>Date: ${dateStr}${timeStr ? ` at ${timeStr}` : ""}`;
  if (mL) mL.innerHTML = `<i class="fa-solid fa-location-dot mr-2 text-victoria-blue"></i>Location: ${locStr}`;
  if (mDesc) mDesc.innerHTML = descStr;

  if (mImg && mImgWrap) {
    if (imgUrl) {
      mImg.src = imgUrl;
      mImg.alt = title;
      mImgWrap.classList.remove("hidden");
    } else {
      mImg.src = "";
      mImgWrap.classList.add("hidden");
    }
  }

  window.openModal("admin-view-event-modal");
};
window.viewVolunteerNotes = function (notes, name) {
  const modal = document.createElement("div");
  modal.className =
    "fixed inset-0 bg-gray-900/80 backdrop-blur-sm flex items-center justify-center p-4 z-[180]";
  modal.id = "notes-viewer-modal";
  modal.onclick = function (e) {
    if (e.target === this) this.remove();
  };
  modal.innerHTML = `<div class="bg-white rounded-2xl max-w-lg w-full shadow-2xl border modal-enter"><div class="p-6"><div class="flex items-center justify-between mb-4"><h3 class="text-lg font-extrabold text-victoria-blue">Volunteer Notes</h3><button onclick="document.getElementById('notes-viewer-modal').remove()" class="text-gray-400 hover:text-gray-600 p-2"><i class="fa-solid fa-xmark text-xl"></i></button></div><p class="text-xs text-stone-500 mb-3">From: <span class="font-semibold">${name}</span></p><div class="bg-gray-50 p-4 rounded-xl border max-h-60 overflow-y-auto"><p class="text-sm leading-relaxed whitespace-pre-line">${notes}</p></div><button onclick="document.getElementById('notes-viewer-modal').remove()" class="mt-4 w-full bg-gray-100 text-gray-700 font-semibold py-2.5 rounded-xl text-sm hover:bg-gray-200">Close</button></div></div>`;
  document.body.appendChild(modal);
};
function initDigitalCheckInsListener() {
  onSnapshot(
    query(
      collection(db, "participants"),
      where("status", "in", [STATUS.REGISTERED, STATUS.COMPLETED]),
      orderBy("status"),
      orderBy("timestamp", "desc"),
    ),
    (snap) => {
      const s = document.getElementById("hour-participant-select");
      if (!s) return;
      s.innerHTML = "";
      digitalCheckInRegistry = [];
      if (snap.empty) {
        s.innerHTML = '<option value="">No Check-Ins Found</option>';
        return;
      }
      let o = '<option value="">Select Participant...</option>';
      let hp = false;
      snap.forEach((d) => {
        const i = d.data(),
          id = d.id;
        digitalCheckInRegistry.push({ id, ...i });
        if (i.status !== STATUS.COMPLETED) {
          hp = true;
          o += `<option value="${id}">${i.residentName} - ${i.eventTitle || "No Title"}</option>`;
        }
      });
      if (!hp) o = '<option value="">All credited</option>';
      s.innerHTML = o;
    },
  );
  onSnapshot(
    query(collection(db, "service_hours"), orderBy("certifiedAt", "desc")),
    (snap) => {
      const tbody = document.getElementById("admin-hours-tbody");
      if (!tbody) return;
      if (snap.empty) {
        tbody.innerHTML =
          '<tr><td colspan="6" class="px-4 py-3 text-center text-sm text-stone-400">No hours recorded yet.</td></tr>';
        return;
      }
      let h = "";
      snap.forEach((d) => {
        const hr = d.data(),
          id = d.id;
        let sb = "";
        if (hr.status === STATUS.APPROVED)
          sb =
            '<span class="badge-success px-2 py-0.5 rounded text-[8px] font-bold">Credited</span>';
        else if (hr.status === STATUS.REJECTED)
          sb =
            '<span class="badge-danger px-2 py-0.5 rounded text-[8px] font-bold">Rejected</span>';
        else
          sb =
            '<span class="badge-warning px-2 py-0.5 rounded text-[8px] font-bold">Pending</span>';
        const cd = formatFirebaseTimestamp(
          hr.certifiedAt || hr.rejectedAt || hr.restoredAt,
        );
        h += `<tr class="hover:bg-blue-50/60 cursor-pointer border-b transition-colors service-ledger-row" onclick="openServiceHourDetailsModal('${id}')"><td class="px-4 py-3 font-bold">${hr.residentName || "N/A"}</td><td class="px-4 py-3 font-medium">${hr.eventTitle || "N/A"}</td><td class="px-4 py-3 font-black text-center tabular-nums"><span class="inline-flex items-center gap-1.5 hover:text-victoria-blue" title="Click to view and edit hours">${hr.hours || 0} hrs <i class="fa-solid fa-pen-to-square text-[10px] text-slate-400"></i></span></td><td class="px-4 py-3">${sb}</td><td class="px-4 py-3 text-xs"><div>${hr.certifiedBy || hr.rejectedBy || hr.restoredBy || "System"}</div><div class="text-stone-400">${cd}</div></td></tr>`;
      });
      tbody.innerHTML = h;
      if (typeof window.filterServiceHoursLedger === "function") {
        window.filterServiceHoursLedger();
      }
    },
  );
}
function initActivityLogsListener() {
  const tbody = document.getElementById("activity-logs-tbody");
  if (!tbody) return;
  const dropdown = document.getElementById("activity-filter-select");
  if (dropdown) dropdown.value = "all";
  const sortDropdown = document.getElementById("activity-sort-select");
  if (sortDropdown) sortDropdown.value = "date-desc";
  onSnapshot(
    query(
      collection(db, "participants"),
      where("status", "!=", STATUS.TRASHED),
      orderBy("status"),
      orderBy("timestamp", "desc"),
    ),
    (snap) => {
      if (snap.empty) {
        tbody.innerHTML =
          '<tr><td colspan="4" class="px-4 py-6 text-center text-stone-400">No activity logs yet.</td></tr>';
        allActivityLogs = [];
        refreshActionBadges();
        return;
      }
      allActivityLogs = [];
      snap.forEach((d) => {
        allActivityLogs.push({ id: d.id, ...d.data() });
      });
      renderSortedActivityLogs();
      refreshActionBadges();
      const cf = dropdown?.value || "all";
      if (cf !== "all") window.filterActivityLogs(cf);
    },
  );
}
function renderSortedActivityLogs() {
  const tbody = document.getElementById("activity-logs-tbody");
  if (!tbody) return;
  const sl = [...allActivityLogs].sort((a, b) => {
    // New / active event registrations are pushed to the top
    const aIsNew = a.status === STATUS.REGISTERED;
    const bIsNew = b.status === STATUS.REGISTERED;
    if (aIsNew !== bIsNew) {
      return aIsNew ? -1 : 1;
    }
    if (activityLogSortField === "name") {
      const nA = (a.residentName || "").toLowerCase(),
        nB = (b.residentName || "").toLowerCase();
      return activityLogSortDirection === "asc"
        ? nA.localeCompare(nB)
        : nB.localeCompare(nA);
    } else {
      const dA = a.timestamp?.toDate
        ? a.timestamp.toDate()
        : new Date(a.timestamp || 0),
        dB = b.timestamp?.toDate
          ? b.timestamp.toDate()
          : new Date(b.timestamp || 0);
      return activityLogSortDirection === "asc" ? dA - dB : dB - dA;
    }
  });
  if (sl.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="4" class="px-4 py-6 text-center text-stone-400">No activity logs yet.</td></tr>';
    return;
  }
  let h = "";
  sl.forEach((log) => {
    let rs = "";
    if (log.status === STATUS.REGISTERED) {
      rs = "hover:bg-blue-50/50";
    } else if (log.status === STATUS.CANCELLED) {
      rs = "hover:bg-red-50/50";
    } else if (log.status === STATUS.COMPLETED) {
      rs = "hover:bg-emerald-50/50";
    } else if (log.status === STATUS.REJECTED) {
      rs = "hover:bg-red-50/50";
    } else {
      rs = "hover:bg-stone-50";
    }
    const ts = log.timestamp?.toDate
      ? log.timestamp.toDate()
      : new Date(log.timestamp || Date.now());
    const fd = ts.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    const ft = ts.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
    const isNew = log.status === STATUS.REGISTERED;
    let actionsHtml = '<div class="flex items-center justify-end gap-1.5">';
    const escId = (log.id || "").replace(/'/g, "\\'");
    const escName = (log.residentName || "Resident").replace(/'/g, "\\'");
    const escEvent = (log.eventTitle || "Event").replace(/'/g, "\\'");

    if (log.status === STATUS.REGISTERED) {
      actionsHtml += `<button type="button" onclick="event.stopPropagation(); rejectParticipantRegistration('${escId}', '${escName}', '${escEvent}')" class="px-2.5 py-1 text-xs font-semibold rounded bg-rose-50 text-rose-600 hover:bg-rose-600 hover:text-white transition-all inline-flex items-center gap-1 shadow-sm" title="Reject participant registration"><i class="fa-solid fa-xmark"></i><span>Reject</span></button>`;
    } else if (log.status === STATUS.REJECTED) {
      actionsHtml += `<button type="button" onclick="event.stopPropagation(); resetParticipantRegistration('${escId}', '${escName}')" class="px-2.5 py-1 text-xs font-semibold rounded bg-amber-50 text-amber-600 hover:bg-amber-600 hover:text-white transition-all inline-flex items-center gap-1 shadow-sm" title="Reset back to Registered"><i class="fa-solid fa-rotate-left"></i><span>Reset</span></button>`;
    }

    // Specific record delete button (satisfies: "There should be delete for a specific data rather than deleting all table data")
    actionsHtml += `<button type="button" onclick="event.stopPropagation(); deleteParticipantRecord('${escId}', '${escName}', '${escEvent}')" class="w-7 h-7 rounded text-slate-400 hover:bg-rose-50 hover:text-rose-600 transition-all flex items-center justify-center shrink-0" title="Delete this specific registration record"><i class="fa-solid fa-trash-can text-xs"></i></button>`;
    actionsHtml += "</div>";

    h += `<tr class="border-b ${isNew ? "row-new " : ""}${rs} activity-log-row" data-status="${log.status || "unknown"}" data-resident="${(log.residentName || "").toLowerCase()}" data-event="${(log.eventTitle || "").toLowerCase()}"><td class="px-4 py-3 font-bold">${log.residentName || "N/A"}${isNew ? " " + newChipHtml() : ""}</td><td class="px-4 py-3 font-medium">${log.eventTitle || "N/A"}</td><td class="px-4 py-3"><div class="text-xs">${fd}</div><div class="text-xs text-stone-500">${ft}</div></td><td class="px-4 py-3 text-right">${actionsHtml}</td></tr>`;
  });
  tbody.innerHTML = h;
  window.filterActivityLogs();
}
window.deleteEvent = function (id) {
  window.showConfirmPopup(
    "Delete Event?",
    "This removes all registrations.",
    async () => {
      window.showLoading();
      try {
        await deleteDoc(doc(db, "events", id));
        const ps = await getDocs(
          query(collection(db, "participants"), where("eventId", "==", id)),
        );
        const b = writeBatch(db);
        ps.forEach((d) => b.delete(d.ref));
        await b.commit();
        window.showAdminAlert("Success", "Event deleted.", true);
      } catch (e) {
        window.showAdminAlert("Error", e.message, false);
      } finally {
        window.hideLoading();
      }
    },
  );
};
window.openEditAnnouncement = async function (id) {
  window.showLoading();
  try {
    const s = await getDoc(doc(db, "announcements", id));
    if (!s.exists()) {
      window.hideLoading();
      window.showAdminAlert("Error", "Announcement not found.", false);
      return;
    }
    const a = s.data();
    const existingImage = (a.imageUrl || a.image || "").trim();
    editingAnnouncementImage = existingImage;

    document.getElementById("edit-ann-id").value = id;
    document.getElementById("edit-ann-title").value = a.title || "";
    document.getElementById("edit-ann-priority").value = a.priority || "Normal";
    document.getElementById("edit-ann-desc").value = a.desc || "";

    const imgInput = document.getElementById("edit-ann-image");
    // Base64 uploads are too long for the URL box - keep them in memory instead.
    if (imgInput)
      imgInput.value = existingImage.startsWith("data:") ? "" : existingImage;

    const preview = document.getElementById("edit-ann-current-image");
    const previewWrap = document.getElementById("edit-ann-current-image-wrap");
    if (preview && previewWrap) {
      if (existingImage) {
        preview.src = existingImage;
        previewWrap.classList.remove("hidden");
      } else {
        preview.src = "";
        previewWrap.classList.add("hidden");
      }
    }

    const removeWrap = document.getElementById("edit-ann-remove-image-wrap");
    const removeBox = document.getElementById("edit-ann-remove-image");
    if (removeBox) removeBox.checked = false;
    if (removeWrap) {
      removeWrap.classList.toggle("hidden", !existingImage);
      removeWrap.classList.toggle("flex", Boolean(existingImage));
    }

    const fileInput = document.getElementById("edit-ann-image-file");
    if (fileInput) fileInput.value = "";
    const fileLabel = document.getElementById("edit-ann-image-file-label");
    if (fileLabel)
      fileLabel.textContent =
        "Original retained when possible · high-quality optimization · 8 MB max";

    if (typeof setEditAnnouncementImageSource === "function")
      setEditAnnouncementImageSource("url");

    const meta = document.getElementById("edit-ann-meta");
    if (meta) {
      const posted = `Posted by ${a.createdBy || "Admin"} on ${formatFirebaseTimestamp(a.createdAt)}`;
      meta.textContent = a.updatedAt
        ? `${posted} · Last edited by ${a.updatedBy || "Admin"} on ${formatFirebaseTimestamp(a.updatedAt)}`
        : posted;
    }

    window.toggleModal("edit-announcement-modal");
  } catch (err) {
    window.showAdminAlert("Error", "Failed to load announcement.", false);
  } finally {
    window.hideLoading();
  }
};

async function handleEditAnnouncementSubmit(e) {
  e.preventDefault();
  const id = document.getElementById("edit-ann-id")?.value;
  if (!id) {
    window.showAdminAlert("Error", "No announcement selected.", false);
    return;
  }
  const t = document.getElementById("edit-ann-title")?.value.trim() || "";
  const p = document.getElementById("edit-ann-priority")?.value || "Normal";
  const d = document.getElementById("edit-ann-desc")?.value.trim() || "";
  if (!t || !d) {
    window.showAdminAlert("Error", "Fill all fields.", false);
    return;
  }
  window.showLoading();
  try {
    const selectedSource =
      typeof selectedEditAnnouncementImageSource === "function"
        ? selectedEditAnnouncementImageSource()
        : "url";
    const imageFile = document.getElementById("edit-ann-image-file")
      ?.files?.[0];
    const removeImage = Boolean(
      document.getElementById("edit-ann-remove-image")?.checked,
    );
    const typedUrl =
      document.getElementById("edit-ann-image")?.value.trim() || "";

    let imageUrl = "";
    if (removeImage) {
      imageUrl = "";
    } else if (
      selectedSource === "upload" &&
      imageFile &&
      typeof prepareHighQualityImage === "function"
    ) {
      imageUrl = await prepareHighQualityImage(imageFile);
    } else if (typedUrl) {
      imageUrl = typedUrl;
    } else {
      // Nothing new provided - keep whatever image the announcement already had.
      imageUrl = editingAnnouncementImage || "";
    }

    await updateDoc(doc(db, "announcements", id), {
      title: t,
      priority: p,
      desc: d,
      imageUrl: imageUrl || "",
      updatedBy: getAdminDisplayName(),
      updatedById: loggedInAdmin?.id || "system",
      updatedAt: serverTimestamp(),
    });
    editingAnnouncementImage = "";
    window.toggleModal("edit-announcement-modal");
    window.showAdminAlert("Success", "Announcement updated!", true);
  } catch (err) {
    window.showAdminAlert("Error", err.message, false);
  } finally {
    window.hideLoading();
  }
}

window.deleteAnnouncement = function (id) {
  window.showConfirmPopup("Delete?", "Delete this?", async () => {
    window.showLoading();
    try {
      await deleteDoc(doc(db, "announcements", id));
      window.showAdminAlert("Success", "Deleted.", true);
    } catch (e) {
      window.showAdminAlert("Error", e.message, false);
    } finally {
      window.hideLoading();
    }
  });
};

function updateAdminHeaderUI() {
  const nameEl = document.getElementById("header-user-name");
  const sideNameEl = document.getElementById("sidebar-user-name");
  const sideEmailEl = document.getElementById("sidebar-user-email");
  const name =
    typeof loggedInAdmin !== "undefined" && loggedInAdmin && loggedInAdmin.name
      ? loggedInAdmin.name
      : typeof getAdminDisplayName === "function"
        ? getAdminDisplayName()
        : "Main Administrator";
  const email =
    typeof loggedInAdmin !== "undefined" && loggedInAdmin && loggedInAdmin.email
      ? loggedInAdmin.email
      : "admin@victoria.gov.ph";
  if (nameEl) nameEl.textContent = name;
  if (sideNameEl) sideNameEl.textContent = name;
  if (sideEmailEl) sideEmailEl.textContent = email;
}
const TAB_TITLES_ADMIN = {
  announcements: "Announcements",
  contacts: "Feedback",
  events: "Events",
  volunteers: "Volunteers",
  hours: "Service Hours",
  donations: "Donations",
  residents: "Residents Registry",
};

window.switchTab = function (tabId) {
  // INSTANT tab switching (mirrored from the Organizer Console): the data
  // is already live via onSnapshot listeners, so there is nothing to load —
  // no overlay, no artificial delay.
  document
    .querySelectorAll(".tab-content")
    .forEach((el) => el.classList.add("hidden"));
  const target = document.getElementById(tabId);
  if (target) target.classList.remove("hidden");

  const titleEl = document.getElementById("page-title");
  if (titleEl && TAB_TITLES_ADMIN[tabId]) {
    titleEl.textContent = TAB_TITLES_ADMIN[tabId];
  }

  document.querySelectorAll(".nav-link").forEach((b) => {
    b.classList.remove("active");
    const btnTab =
      b.getAttribute("data-tab") ||
      (b.getAttribute("onclick") &&
        b.getAttribute("onclick").match(/['"]([^'"]+)['"]/)?.[1]);
    if (btnTab === tabId) {
      b.classList.add("active");
    }
  });
  saveActiveTab(tabId);

  // Sync table result counts and active filters when switching tabs
  if (tabId === "donations" && typeof window.filterDonations === "function") {
    window.filterDonations();
  } else if (tabId === "volunteers" && typeof window.filterVolunteers === "function") {
    window.filterVolunteers();
  } else if (tabId === "activity-logs" && typeof window.filterActivityLogs === "function") {
    window.filterActivityLogs();
  } else if (tabId === "hours" && typeof window.filterServiceHoursLedger === "function") {
    window.filterServiceHoursLedger();
  } else if (tabId === "contacts" && typeof window.filterContactMessages === "function") {
    window.filterContactMessages();
  }
};

// ===== EXPORT GLOBALS =====
window.updateVolunteerStatus = window.updateVolunteerStatus;
window.rejectServiceHours = window.rejectServiceHours;
window.restoreServiceHours = window.restoreServiceHours;
window.bulkApproveVolunteers = window.bulkApproveVolunteers;
window.updateDonationStatus = window.updateDonationStatus;
window.getAdminDisplayName = getAdminDisplayName;
window.filterActivityLogs = window.filterActivityLogs;
window.sortActivityLogs = window.sortActivityLogs;
window.openEditEventModal = window.openEditEventModal;
window.createNotification = createNotification;
window.viewContactMessage = window.viewContactMessage;
window.updateContactStatus = window.updateContactStatus;
window.deleteContactMessage = window.deleteContactMessage;
window.downloadAttachment = window.downloadAttachment;
// ===== IMAGE UPLOAD & OPTIMIZATION HELPERS (FROM ORGANIZER) =====
function safeImageUrl(value) {
  if (!value || typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed.startsWith("data:image/")) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:") return trimmed;
  } catch (e) { }
  return "";
}

function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const units = ["B", "KB", "MB", "GB"];
  const idx = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, idx)).toFixed(1))} ${units[idx]}`;
}

async function loadLocalImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Unable to decode the image file."));
    };
    img.src = url;
  });
}

function readLocalFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read local file."));
    reader.readAsDataURL(file);
  });
}

async function prepareHighQualityImage(file) {
  const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
  if (!allowedTypes.includes(file.type)) {
    throw new Error("Attach a JPG, PNG, or WebP image file.");
  }
  if (file.size > 8 * 1024 * 1024) {
    throw new Error("The source image must not exceed 8 MB.");
  }
  const image = await loadLocalImage(file);
  const largestSide = Math.max(image.naturalWidth, image.naturalHeight);
  if (!largestSide)
    throw new Error("The selected image has invalid dimensions.");

  const maximumDataUrlLength = 820000;
  const originalDataUrl = await readLocalFileAsDataUrl(file);
  if (originalDataUrl.length <= maximumDataUrlLength) return originalDataUrl;

  const baseScale = Math.min(1, 2560 / largestSide);
  const scaleLevels = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4];
  const qualityLevels = [0.96, 0.92, 0.88, 0.84];

  for (const scaleLevel of scaleLevels) {
    const scale = baseScale * scaleLevel;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context)
      throw new Error("This browser cannot prepare the image attachment.");

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    for (const quality of qualityLevels) {
      let dataUrl = canvas.toDataURL("image/webp", quality);
      if (dataUrl.length <= maximumDataUrlLength) return dataUrl;
      dataUrl = canvas.toDataURL("image/jpeg", quality);
      if (dataUrl.length <= maximumDataUrlLength) return dataUrl;
    }
  }
  throw new Error(
    "The image is too complex to fit safely. Please select a smaller photo.",
  );
}

function setAnnouncementImageSource(source = "url") {
  const selected = document.querySelector(
    `input[name="ann-image-source"][value="${source}"]`,
  );
  if (selected) selected.checked = true;
  document
    .getElementById("ann-image-url-panel")
    ?.classList.toggle("hidden", source !== "url");
  document
    .getElementById("ann-image-upload-panel")
    ?.classList.toggle("hidden", source !== "upload");
}

function selectedAnnouncementImageSource() {
  return (
    document.querySelector('input[name="ann-image-source"]:checked')?.value ||
    "url"
  );
}

function setEditAnnouncementImageSource(source = "url") {
  const selected = document.querySelector(
    `input[name="edit-ann-image-source"][value="${source}"]`,
  );
  if (selected) selected.checked = true;
  document
    .getElementById("edit-ann-image-url-panel")
    ?.classList.toggle("hidden", source !== "url");
  document
    .getElementById("edit-ann-image-upload-panel")
    ?.classList.toggle("hidden", source !== "upload");
}

function selectedEditAnnouncementImageSource() {
  return (
    document.querySelector('input[name="edit-ann-image-source"]:checked')
      ?.value || "url"
  );
}

function setEventImageSource(prefix = "", source = "url") {
  const fieldName = prefix ? "edit-event-image-source" : "event-image-source";
  const selected = document.querySelector(
    `input[name="${fieldName}"][value="${source}"]`,
  );
  if (selected) selected.checked = true;
  document
    .getElementById(`${prefix}event-image-url-panel`)
    ?.classList.toggle("hidden", source !== "url");
  document
    .getElementById(`${prefix}event-image-upload-panel`)
    ?.classList.toggle("hidden", source !== "upload");
}

function selectedEventImageSource(prefix = "") {
  const fieldName = prefix ? "edit-event-image-source" : "event-image-source";
  return (
    document.querySelector(`input[name="${fieldName}"]:checked`)?.value || "url"
  );
}

// Setup radio and file listeners on DOMContentLoaded
document.addEventListener("DOMContentLoaded", () => {
  document
    .querySelectorAll('input[name="ann-image-source"]')
    .forEach((radio) => {
      radio.addEventListener("change", () =>
        setAnnouncementImageSource(radio.value),
      );
    });
  document
    .getElementById("ann-image-file")
    ?.addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      const lbl = document.getElementById("ann-image-file-label");
      if (lbl)
        lbl.textContent = file
          ? `${file.name} · ${formatFileSize(file.size)}`
          : "Original retained when possible · high-quality optimization · 8 MB max";
    });

  document
    .querySelectorAll('input[name="edit-ann-image-source"]')
    .forEach((radio) => {
      radio.addEventListener("change", () =>
        setEditAnnouncementImageSource(radio.value),
      );
    });
  document
    .getElementById("edit-ann-image-file")
    ?.addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      const lbl = document.getElementById("edit-ann-image-file-label");
      if (lbl)
        lbl.textContent = file
          ? `${file.name} · ${formatFileSize(file.size)}`
          : "Original retained when possible · high-quality optimization · 8 MB max";
    });

  document
    .querySelectorAll('input[name="event-image-source"]')
    .forEach((radio) => {
      radio.addEventListener("change", () =>
        setEventImageSource("", radio.value),
      );
    });
  document
    .getElementById("event-image-file")
    ?.addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      const lbl = document.getElementById("event-image-file-label");
      if (lbl)
        lbl.textContent = file
          ? `${file.name} · ${formatFileSize(file.size)}`
          : "Original retained when possible · high-quality optimization · 8 MB max";
    });

  document
    .querySelectorAll('input[name="edit-event-image-source"]')
    .forEach((radio) => {
      radio.addEventListener("change", () =>
        setEventImageSource("edit-", radio.value),
      );
    });
  document
    .getElementById("edit-event-image-file")
    ?.addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      const lbl = document.getElementById("edit-event-image-file-label");
      if (lbl)
        lbl.textContent = file
          ? `${file.name} · ${formatFileSize(file.size)}`
          : "Original retained when possible · high-quality optimization · 8 MB max";
    });
});

// ===== DONATION PAYMENT SCREENSHOT VERIFICATION MODAL (ADMIN) =====
function openDonationScreenshotModal(donationId) {
  const donation = allDonations.find(
    (d) => String(d.id) === String(donationId),
  );
  if (!donation) return;

  const modal = document.getElementById("donation-screenshot-modal");
  if (!modal) return;

  const donorNameEl = document.getElementById("proof-donor-name");
  const amountEl = document.getElementById("proof-amount");
  const methodEl = document.getElementById("proof-method");
  const txEl = document.getElementById("proof-tx-id");
  const imgEl = document.getElementById("proof-screenshot-img");
  const noImgEl = document.getElementById("proof-no-img-msg");
  const downloadBtn = document.getElementById("proof-download-btn");
  const actionsLeft = document.getElementById("proof-modal-actions-left");

  if (donorNameEl) donorNameEl.textContent = donation.donorName || "Anonymous";
  const amt = donation.amount
    ? `₱${parseFloat(donation.amount).toLocaleString()}`
    : donation.item || "N/A";
  if (amountEl) amountEl.textContent = amt;
  if (methodEl) {
    const modalShotUrl =
      typeof safeImageUrl === "function"
        ? safeImageUrl(
          donation.paymentScreenshot ||
          donation.screenshot ||
          donation.proofOfPayment ||
          "",
        )
        : donation.paymentScreenshot || "";
    methodEl.textContent = formatPaymentMethodName(
      donation.paymentMethod || (modalShotUrl ? "E-Wallet / Bank" : "Cash / Item"),
    );
  }
  if (txEl)
    txEl.textContent =
      donation.transactionId || donation.txId || donation.id || "N/A";

  const screenshotUrl =
    typeof safeImageUrl === "function"
      ? safeImageUrl(
        donation.paymentScreenshot ||
        donation.screenshot ||
        donation.proofOfPayment ||
        "",
      )
      : donation.paymentScreenshot ||
      donation.screenshot ||
      donation.proofOfPayment ||
      "";
  if (screenshotUrl) {
    if (imgEl) {
      imgEl.src = screenshotUrl;
      imgEl.classList.remove("hidden");
    }
    if (noImgEl) noImgEl.classList.add("hidden");
    if (downloadBtn) {
      downloadBtn.href = screenshotUrl;
      downloadBtn.download = `Donation-Receipt-${donation.id}.png`;
      downloadBtn.classList.remove("hidden");
    }
  } else {
    if (imgEl) {
      imgEl.src = "";
      imgEl.classList.add("hidden");
    }
    if (noImgEl) noImgEl.classList.remove("hidden");
    if (downloadBtn) downloadBtn.classList.add("hidden");
  }

  if (actionsLeft) {
    const status = effectiveStatus(donation);
    let btns = "";
    if (![STATUS.APPROVED, STATUS.CONFIRMED, STATUS.REFUNDED].includes(status)) {
      btns += `<button type="button" data-action="donation-status" data-id="${donation.id}" data-status="${STATUS.APPROVED}" onclick="updateDonationStatusFromProof('${donation.id}', '${STATUS.APPROVED}')" class="text-xs font-normal bg-emerald-600 text-white px-3.5 py-2 rounded-md hover:bg-emerald-700 shadow-sm flex items-center gap-1.5"><i class="fa-solid fa-check"></i>Confirm Payment</button>`;
    }
    if (status !== STATUS.REJECTED && status !== STATUS.REFUNDED) {
      btns += `<button type="button" data-action="donation-status" data-id="${donation.id}" data-status="${STATUS.REJECTED}" onclick="updateDonationStatusFromProof('${donation.id}', '${STATUS.REJECTED}')" class="text-xs font-bold bg-rose-600 text-white px-3.5 py-2 rounded-xl hover:bg-rose-700 shadow-sm flex items-center gap-1.5"><i class="fa-solid fa-xmark"></i>Reject Payment</button>`;
    }
    if (isEligibleForRefund(donation)) {
      btns += `<button type="button" onclick="refundDonationRecord('${donation.id}', '${(donation.donorName || 'Donor').replace(/'/g, "\\'")}', '${donation.amount ? '₱' + parseFloat(donation.amount).toLocaleString() : ''}', '${(donation.paymentMethod || '').replace(/'/g, "\\'")}')" class="text-xs font-semibold bg-amber-500 text-white hover:bg-amber-600 px-3 py-2 rounded-xl shadow-sm flex items-center gap-1.5 ml-2"><i class="fa-solid fa-rotate-left"></i>Refund (3 Days)</button>`;
    }
    btns += `<button type="button" onclick="deleteDonationRecord('${donation.id}', '${(donation.donorName || 'Donor').replace(/'/g, "\\'")}')" class="text-xs font-semibold bg-slate-100 text-rose-600 hover:bg-rose-50 border border-rose-200 px-3 py-2 rounded-xl shadow-sm flex items-center gap-1.5 ml-2"><i class="fa-solid fa-trash-can"></i>Delete Record</button>`;
    actionsLeft.innerHTML = btns;
  }

  window.openModal(modal);
}

function closeDonationScreenshotModal() {
  window.closeModal("donation-screenshot-modal");
}

function updateDonationStatusFromProof(donationId, newStatus) {
  closeDonationScreenshotModal();
  updateDonationStatus(donationId, newStatus);
}

window.openDonationScreenshotModal = openDonationScreenshotModal;
window.closeDonationScreenshotModal = closeDonationScreenshotModal;
window.updateDonationStatusFromProof = updateDonationStatusFromProof;
// ========================================== CONTACT MESSAGES FILTER ==========================================
window.filterContactMessages = function () {
  const d = document.getElementById("contact-filter-select");
  const filter = (d?.value || "all").toLowerCase();
  const searchInput = document.getElementById("contact-search-input");
  const query = (searchInput?.value || "").trim().toLowerCase();

  let visible = 0;
  document.querySelectorAll(".contact-message-row").forEach((r) => {
    const rs = (r.getAttribute("data-status") || "").toLowerCase();
    const rowText = r.textContent.toLowerCase();

    const matchesStatus = filter === "all" || rs === filter;
    const matchesQuery = !query || rowText.includes(query);

    const show = matchesStatus && matchesQuery;
    r.style.display = show ? "" : "none";
    if (show) visible++;
  });

  const rc = document.getElementById("contact-result-count");
  if (rc) {
    rc.textContent = `${visible} ${visible === 1 ? "message" : "messages"}`;
  }
};

// ========================================== SERVICE LEDGER FILTER & MODAL ==========================================
window.filterServiceHoursLedger = function () {
  const searchInput = document.getElementById("hours-ledger-search");
  const query = (searchInput?.value || "").trim().toLowerCase();
  document.querySelectorAll(".service-ledger-row").forEach((r) => {
    const rowText = r.textContent.toLowerCase();
    r.style.display = !query || rowText.includes(query) ? "" : "none";
  });
};

let currentServiceHourId = null;

window.openServiceHourDetailsModal = async function (id) {
  window.showLoading();
  try {
    currentServiceHourId = id;
    const s = await getDoc(doc(db, "service_hours", id));
    if (!s.exists()) {
      window.hideLoading();
      window.showAdminAlert("Error", "Service hour entry not found.", false);
      return;
    }
    const d = s.data();
    const resEl = document.getElementById("hour-modal-resident");
    const evEl = document.getElementById("hour-modal-event");
    const hrEl = document.getElementById("hour-modal-hours");
    const hrInput = document.getElementById("hour-modal-hours-input");
    const stEl = document.getElementById("hour-modal-status-box");
    const actEl = document.getElementById("hour-modal-actions");

    if (resEl) resEl.textContent = d.residentName || "N/A";
    if (evEl) evEl.textContent = d.eventTitle || "N/A";
    if (hrEl) hrEl.textContent = `${d.hours || 0} hrs`;
    if (hrInput) hrInput.value = d.hours !== undefined ? d.hours : 0;

    if (stEl) {
      let statusHtml = "";
      if (d.status === STATUS.APPROVED) {
        statusHtml = '<span class="badge-success px-2.5 py-1 rounded text-xs font-bold inline-block">Credited</span>';
      } else if (d.status === STATUS.REJECTED) {
        statusHtml = '<span class="badge-danger px-2.5 py-1 rounded text-xs font-bold inline-block">Rejected</span>';
      } else {
        statusHtml = '<span class="badge-warning px-2.5 py-1 rounded text-xs font-bold inline-block">Pending</span>';
      }
      stEl.innerHTML = statusHtml;
    }

    if (actEl) {
      let actionsHtml = "";
      if (d.status !== STATUS.REJECTED) {
        actionsHtml += `<button type="button" onclick="closeServiceHourDetailsModal(); rejectServiceHours('${id}')" class="text-xs font-semibold bg-rose-600 text-white px-3.5 py-2 rounded-xl hover:bg-rose-700 shadow-sm flex items-center gap-1.5"><i class="fa-solid fa-xmark"></i>Reject Credit</button>`;
      }
      if (d.status === STATUS.REJECTED) {
        actionsHtml += `<button type="button" onclick="closeServiceHourDetailsModal(); restoreServiceHours('${id}')" class="text-xs font-semibold bg-emerald-600 text-white px-3.5 py-2 rounded-xl hover:bg-emerald-700 shadow-sm flex items-center gap-1.5"><i class="fa-solid fa-rotate-left"></i>Restore Credit</button>`;
      }
      actEl.innerHTML = actionsHtml;
    }
    window.openModal("hour-details-modal");
  } catch (err) {
    window.showAdminAlert("Error", "Failed to load entry details.", false);
  } finally {
    window.hideLoading();
  }
};

window.saveServiceHourEdit = async function () {
  if (!currentServiceHourId) {
    window.showAdminAlert("Error", "No service hour entry selected.", false);
    return;
  }
  const hrInput = document.getElementById("hour-modal-hours-input");
  const newHours = parseFloat(hrInput?.value);
  if (isNaN(newHours) || newHours <= 0) {
    window.showAdminAlert("Invalid Input", "Please enter a valid positive number of hours.", false);
    return;
  }
  window.showLoading();
  try {
    const docRef = doc(db, "service_hours", currentServiceHourId);
    const snap = await getDoc(docRef);
    const d = snap.exists() ? snap.data() : null;

    await updateDoc(docRef, {
      hours: newHours,
      updatedAt: serverTimestamp(),
      updatedBy: getAdminDisplayName(),
      updatedById: loggedInAdmin?.id || "system",
    });

    const recipientId = d?.residentId || d?.userId;
    if (recipientId) {
      try {
        await createNotification(
          recipientId,
          "Service Hours Updated",
          `Your accredited service hours for "${d?.eventTitle || "community activity"}" were updated to ${newHours} hrs by ${getAdminDisplayName()}.`,
          "service_hours",
        );
      } catch (notifErr) {
        console.warn("Could not dispatch hours update notification:", notifErr);
      }
    }

    const hrEl = document.getElementById("hour-modal-hours");
    if (hrEl) hrEl.textContent = `${newHours} hrs`;

    window.closeServiceHourDetailsModal();
    window.showAdminAlert("Hours Saved", `Successfully updated service hours to ${newHours} hrs.`, true);
  } catch (err) {
    window.showAdminAlert("Error", err.message || "Failed to update service hours.", false);
  } finally {
    window.hideLoading();
  }
};

window.closeServiceHourDetailsModal = function () {
  window.closeModal("hour-details-modal");
};

// Global backdrop close handler for modals
document.addEventListener("click", function (e) {
  if (e.target && e.target.getAttribute && e.target.getAttribute("data-close-on-backdrop") === "true") {
    if (e.target.id && typeof window.closeModal === "function") {
      window.closeModal(e.target.id);
    }
  }
});

window.openModal = window.openModal;
window.closeModal = window.closeModal;
window._reopenModal = window._reopenModal;
window.rejectParticipantRegistration = window.rejectParticipantRegistration;
window.resetParticipantRegistration = window.resetParticipantRegistration;
window.deleteParticipantRecord = window.deleteParticipantRecord;
window.deleteVolunteerRecord = window.deleteVolunteerRecord;
window.filterContactMessages = window.filterContactMessages;
window.filterServiceHoursLedger = window.filterServiceHoursLedger;
window.openServiceHourDetailsModal = window.openServiceHourDetailsModal;
window.closeServiceHourDetailsModal = window.closeServiceHourDetailsModal;
window.saveServiceHourEdit = window.saveServiceHourEdit;
window.refundDonationRecord = window.refundDonationRecord;
window.deleteDonationRecord = window.deleteDonationRecord;
window.filterDonations = window.filterDonations;
window.filterVolunteers = window.filterVolunteers;
window.openAdminEventDetails = window.openAdminEventDetails;