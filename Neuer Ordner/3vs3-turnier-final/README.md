# 3vs3 Turnier-Terminfinder (Winter 2026)

Full-Stack-Webanwendung zur synchronen Terminfindung für ein **3vs3-Turnier** (6 Spieler pro Match).

---

## Highlights & Features

- **Echte Datenbank-Persistenz:**
  - **Lokal / Server mit Disk:** Eingebautes SQLite über Node.js (`data/turnier.db`), keine Extra-Setup nötig.
  - **Cloud:** Automatische PostgreSQL-Unterstützung durch Setzen von `DATABASE_URL` (z. B. Supabase, Neon, Render, Railway).
  - Alle Eintragungen, Teams, Spieler und Paarungen bleiben dauerhaft erhalten und sind für alle Teilnehmer synchron.
- **Turnier-Zeitplan (09.11.2026 – 06.12.2026):**
  - **Kick-Off Stream Banner:** Sonntag, 08.11.2026 um 19:00 Uhr mit Countdown-Anzeige.
  - **Phasen mit Farbcodierung:**
    - Woche 1 & 2: Gruppenphase Teil 1 & 2 (Grün)
    - Woche 3: Achtelfinale Hauptrunde (Blau), Trostrunde R1 & R2 (Violett/Lila)
    - Woche 4: Viertelfinale (Orange/Bronze), Ausweichtermin (Silber), Halbfinale (Orange/Bronze), Finale & Platz 3 (Gold)
- **Y-Achse:** Exakt 8:00 bis 24:00 Uhr (16 Stunden-Slots: 08:00–09:00 bis 23:00–24:00).
- **Spieler-Bereich (Passwortlos via Autocomplete-Suche):**
  - Schnelle Live-Suche nach Name (inkl. Team-Anzeige).
  - Grafischer Wochen- & Phasen-Überblick im metallischen Esports-Design.
  - Ampelsystem: Rot (Kann nicht) → Klick 1: Grün (Kann) → Klick 2: Gelb (Unsicher) → Klick 3: Rot.
  - Schnell-Aktionen ("Alles grün", "Zurücksetzen", Klick auf Tag/Stunde schaltet Spalte/Zeile um) & Drag-to-paint.
  - Prominenter Speichern-Button mit Feedback.
- **Match-Abgleich (6-Spieler-Schnittmenge):**
  - Sobald der Admin eine Paarung für das Team anlegt, schaltet sich der Tab frei.
  - Überlagert die Verfügbarkeiten aller 6 Spieler (3 vs. 3).
  - **Leuchtend Grün ("6/6 Grün"):** Perfekter Termin – alle 6 Spieler können.
  - **Gelb-Grün ("5✓ 1?"):** Mögliche Option – niemand ist rot, mindestens einer gelb.
  - **Dunkelrot / Ausgegraut:** Nicht möglich – mindestens ein Spieler hat rot (oder noch nicht eingetragen).
  - Interaktiver Tooltip / Klick zeigt die genaue Detail-Liste aller 6 Spieler und deren Status.
- **Admin-Bereich (Passwort-geschützt, Standard: `admin2026`):**
  1. **Team- & Spieler-Management:** Teams anlegen/umbenennen/löschen, exakt 3 Spieler pro Team zuweisen oder verschieben.
  2. **Paarungen festlegen:** Phase wählen, Team A vs. Team B anlegen, bearbeiten oder löschen.
  3. **Globale Einsicht:**
     - Direkt-Links zu allen Paarungs-Abgleichen.
     - Einzelspieler-Kalender-Ansicht mit Filter nach Phase.
     - Matrix-Übersicht, wer wo bereits Zeiten eingetragen hat.

---

## Schnellanleitung: Lokal starten

1. **Abhängigkeiten installieren:**
   ```bash
   npm install
   ```

2. **Server starten:**
   ```bash
   npm start
   ```
   Die App läuft unter: **http://localhost:3000**

3. **Demo-Daten (optional):**
   ```bash
   npm run seed:demo
   ```
   *(Bereits ausgeführt: 8 Teams, 24 Spieler und Woche-1-Paarungen sind in `data/turnier.db` hinterlegt).*

---

## Cloud-Deployment (Öffentlicher Link)

Für einen öffentlichen Cloud-Link (z. B. auf **Render**, **Railway**, **Fly.io** oder **Vercel/Heroku**):

1. Repository auf GitHub pushen.
2. Web Service erstellen (Node.js runtime, Startbefehl `node server.js`).
3. **Umgebungsvariablen (Environment Variables):**
   - `PORT`: (wird meist vom Cloud-Host gesetzt, Standard `3000`)
   - `ADMIN_PASSWORD`: Dein sicheres Admin-Passwort (Standard `admin2026`)
   - `DATABASE_URL`: Verbindungs-String zu einer Postgres-Datenbank (z. B. kostenloses Supabase oder Neon-Projekt).
     *(Wenn keine `DATABASE_URL` gesetzt ist, wird automatisch die lokale SQLite-Datei `data/turnier.db` verwendet).*
