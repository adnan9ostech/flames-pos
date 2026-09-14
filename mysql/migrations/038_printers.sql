-- Printers as data, not as launch arguments (14 Sep 2026). Re-runnable.
--
-- THE PROBLEM THIS FIXES. Until now a printer was named in the launchd plist
-- that starts the agent: `--queue PrinterCMD_ESCPO_POS80_Printer_USB`. So
-- every machine had to be set up by hand at the command line, and the day a
-- printer is replaced — or its cable moves to another USB port and macOS
-- renames the queue — the till silently stops printing until somebody edits a
-- plist. That is not a setting, it is a trap with a shell prompt in front of it.
--
-- Now the agent is started with WHAT IT IS FOR (`--role receipt` or
-- `--role kitchen`) and looks up WHICH PRINTER from here. Change the printer on
-- the Settings screen and the next bill prints on it, on every terminal, with
-- nothing restarted.
--
-- WHY A PROFILE PER PRINTER. "ESC/POS" is a family, not a standard. Cheap
-- 58mm units cut with GS V 1 or not at all and take a different drawer pin;
-- some need a code page set before Latin text renders; the gap between the
-- print head and the cutter differs by centimetres, which is how many lines
-- have to be fed before cutting or the last line stays inside the machine.
-- Those four differences are what "works with my printer" actually means, so
-- they are columns rather than a code change.
CREATE TABLE IF NOT EXISTS printers (
    id          BIGINT       NOT NULL AUTO_INCREMENT,
    -- What this printer is FOR. The agent asks for its role; nothing anywhere
    -- names a queue.
    role        VARCHAR(16)  NOT NULL,
    label       VARCHAR(96)  NOT NULL,
    -- 'cups'   — a print queue, which is what USB and network printers become
    --            on macOS and Linux. Written with `lp -o raw`.
    -- 'device' — a character device, which is what a Bluetooth serial printer
    --            is. Written to directly.
    transport   VARCHAR(8)   NOT NULL DEFAULT 'cups',
    -- The queue name, or the /dev path. The one machine-specific string, and
    -- it is now typed once on a screen instead of into a plist.
    target      VARCHAR(191) NOT NULL,
    width_mm    TINYINT      NOT NULL DEFAULT 80,
    -- 'full' (GS V 0) | 'partial' (GS V 1) | 'none' for a printer with no
    -- cutter, which then just feeds enough paper to tear by hand.
    cut_mode    VARCHAR(8)   NOT NULL DEFAULT 'full',
    -- Lines fed before the cut. The head-to-cutter gap, in lines.
    feed_lines  TINYINT      NOT NULL DEFAULT 6,
    -- ESC t n. 0 leaves the printer on whatever it booted with, which is right
    -- for almost everything; a unit that prints Latin text as boxes needs one.
    codepage    TINYINT      NOT NULL DEFAULT 0,
    -- Which RJ11 pin opens the drawer hanging off THIS printer. Hardware, so
    -- it belongs here rather than in store-wide settings.
    drawer_pin  TINYINT      NOT NULL DEFAULT 2,
    is_active   TINYINT(1)   NOT NULL DEFAULT 1,
    created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    -- One printer per role. A second till with its own printer is a second
    -- branch's problem, and this schema says so plainly rather than pretending.
    UNIQUE KEY uq_printer_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Seeded from what the agent is being started with today, so the first run
-- after this migration behaves exactly as the last run before it. An empty
-- table is also fine: the agent then discovers the printer itself.
INSERT INTO printers (role, label, transport, target, width_mm)
SELECT 'receipt', 'Counter printer', 'cups', 'PrinterCMD_ESCPO_POS80_Printer_USB', 80
WHERE NOT EXISTS (SELECT 1 FROM printers WHERE role = 'receipt');
