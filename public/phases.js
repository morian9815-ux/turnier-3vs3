/*
 * Turnier-Konfiguration (wird von Server UND Browser genutzt).
 * Phasen, Zeitraster (08:00 – 24:00) und Kick-Off-Termin für das 3vs3-Turnier 2026.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TOURNAMENT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PHASES = [
    { id: 'w1-group',   week: 1, name: 'Gruppenphase',              subtitle: 'Teil 1',      short: 'W1 Gruppe',  start: '2026-11-09', end: '2026-11-15', color: 'green'  },
    { id: 'w2-group',   week: 2, name: 'Gruppenphase',              subtitle: 'Fortsetzung', short: 'W2 Gruppe',  start: '2026-11-16', end: '2026-11-22', color: 'green'  },
    { id: 'w3-r16',     week: 3, name: 'Achtelfinale',              subtitle: 'Hauptrunde',  short: 'Achtelf.',   start: '2026-11-23', end: '2026-11-29', color: 'blue'   },
    { id: 'w3-cons1',   week: 3, name: 'Trostrunde R1',             subtitle: '',            short: 'Trost R1',   start: '2026-11-23', end: '2026-11-25', color: 'purple' },
    { id: 'w3-cons2',   week: 3, name: 'Trostrunde R2',             subtitle: '',            short: 'Trost R2',   start: '2026-11-26', end: '2026-11-29', color: 'purple' },
    { id: 'w4-qf',      week: 4, name: 'Viertelfinale',             subtitle: '',            short: 'Viertelf.',  start: '2026-11-30', end: '2026-12-03', color: 'bronze' },
    { id: 'w4-reserve', week: 4, name: 'Ausweichtermin',            subtitle: '',            short: 'Ausweich',   start: '2026-12-04', end: '2026-12-04', color: 'silver' },
    { id: 'w4-sf',      week: 4, name: 'Halbfinale',                subtitle: '',            short: 'Halbf.',     start: '2026-12-05', end: '2026-12-05', color: 'bronze' },
    { id: 'w4-final',   week: 4, name: 'Finale & Spiel um Platz 3', subtitle: '',            short: 'Finale',     start: '2026-12-06', end: '2026-12-06', color: 'gold'   },
  ];

  const WEEKS = [
    { week: 1, title: 'Woche 1', subtitle: 'Gruppenphase' },
    { week: 2, title: 'Woche 2', subtitle: 'Gruppenphase' },
    { week: 3, title: 'Woche 3', subtitle: 'Achtelfinale & Trostrunde' },
    { week: 4, title: 'Woche 4', subtitle: 'Finalwoche' },
  ];

  // Y-Achse: 08:00 – 24:00 (Stunde 8 = 08:00–09:00 … Stunde 23 = 23:00–24:00)
  const HOURS = Array.from({ length: 16 }, (_, i) => i + 8);

  const KICKOFF = { date: '2026-11-08', time: '19:00', label: 'Kick-Off Stream', iso: '2026-11-08T19:00:00+01:00' };

  const STATUSES = ['red', 'green', 'yellow'];
  const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const WEEKDAYS_LONG = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

  const pad = (n) => String(n).padStart(2, '0');

  function phaseDates(phase) {
    const out = [];
    const d = new Date(phase.start + 'T00:00:00Z');
    const end = new Date(phase.end + 'T00:00:00Z');
    while (d <= end) {
      out.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  }

  function getPhase(id) {
    return PHASES.find((p) => p.id === id) || null;
  }

  function formatDay(iso) {
    const d = new Date(iso + 'T00:00:00Z');
    return {
      weekday: WEEKDAYS[d.getUTCDay()],
      weekdayLong: WEEKDAYS_LONG[d.getUTCDay()],
      short: `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`,
      full: `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`,
    };
  }

  function hourLabel(h) {
    return `${pad(h)}:00 – ${pad(h + 1)}:00`;
  }

  function formatRange(phase) {
    const a = formatDay(phase.start);
    const b = formatDay(phase.end);
    if (phase.start === phase.end) return `${a.weekday}, ${a.full}`;
    return `${a.weekday}, ${a.short} – ${b.weekday}, ${b.full}`;
  }

  return { PHASES, WEEKS, HOURS, KICKOFF, STATUSES, phaseDates, getPhase, formatDay, hourLabel, formatRange };
});
