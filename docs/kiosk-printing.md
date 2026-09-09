# Silent receipt printing (Windows + Chrome)

The app prints the receipt as part of saving a sale. To make that happen with no
dialog and no clicks, Chrome has to be launched with `--kiosk-printing`.

Without that flag everything still works — you just get Chrome's normal print
preview on every sale. That preview appearing is the signal this setup hasn't
been done on a terminal.

## 1. The printer

`--kiosk-printing` always prints to the **Windows default printer**. It cannot
choose one, so:

1. Settings → Bluetooth & devices → Printers & scanners → your thermal printer
   → **Set as default**.
2. Turn off "Let Windows manage my default printer", or Windows will silently
   reassign it to whatever was used last.
3. Printing preferences → **Paper size** → **`80 x 3276mm`** (may appear as
   `80(72.1) x 3276mm`, or as *Roll* / *Continuous*).

   **Do not skip this.** 3276mm is the ESC/POS maximum page length, and a page
   that long cannot paginate — so there is never a mid-bill page break for the
   cutter to act on, and each receipt gets exactly one cut at the end. With a
   short paper size a long bill comes out in several pieces. Confirmed on a Black
   Copper BC858CG1.

   A thermal printer only feeds what it prints, so the long page costs no paper.

4. Set scaling to **100% / Actual size** — never "Fit to page".

The app measures each receipt and asks for a page exactly that tall, so it should
print as one continuous strip with no page break and no blank roll at the end.
But that is only a **request**: Chrome can only use a paper size the driver
actually offers, and the driver decides where a page ends. If a bill comes out in
pieces, that is the mismatch — see the cut section below.

(Worth knowing if you ever touch the print CSS: `@page { size: 80mm auto }` — the
idiom you'll find in most blog posts — does **not** work. Chrome treats mixing a
length with `auto` as invalid, drops the rule, and silently prints US Letter.)

## 2. Prime the profile — do this before the shortcut

**This step is what most silent-printing setups get wrong.**

Kiosk printing has no print preview, so it cannot ask you anything. It reuses the
print settings **already saved in that Chrome profile**. A brand-new
`--user-data-dir` has none, so Chrome falls back to defaults — which include
**headers and footers** (the URL and date printed on your receipt) and default
margins. Those also add height, which can push a receipt onto an extra page and
give you an extra cut.

So teach the profile once, with the preview still available:

1. Launch Chrome with the profile but **without** `--kiosk-printing`:

   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="C:\pos-profile" https://pos.flamesbytheindus.com/pos
   ```

2. Sign in, open any order in **Orders** and press the 🖨 button to get a receipt.
3. In the print dialog set, in this order:
   - **Destination** — the thermal printer
   - **Margins** — None
   - **Scale** — Default (or 100%, never "Fit to page")
   - **Options** — untick **Headers and footers**
4. Press **Print**. That's what saves the settings into the profile.
5. Close Chrome completely.

Now the kiosk shortcut will print silently using exactly those settings.

## 3. The shortcut

Create a desktop shortcut with this as the target:

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --kiosk-printing --user-data-dir="C:\pos-profile" --app=https://pos.flamesbytheindus.com/pos
```

What each part is for:

| Flag | Why |
|---|---|
| `--kiosk-printing` | Prints straight to the default printer, no preview, no dialog |
| `--kiosk` | Reported to be needed alongside it on some Chrome builds for the silent print to take. Harmless if it wasn't |
| `--user-data-dir="C:\pos-profile"` | **Forces a separate Chrome process.** This is what makes the flag take effect at all — see below |
| `--app=<url>` | Chromeless window — no address bar or tabs for staff to wander out of |

`--kiosk` removes the window controls, so know your way back out before setting
this on a machine you aren't sitting at: **Alt+F4** closes it. Drop `--kiosk` if
you'd rather keep a normal window while you're still setting things up — silent
printing does not depend on it in most builds.

## 4. Start it with Windows

Press `Win+R`, run `shell:startup`, and drop a copy of the shortcut in the folder
that opens. The till then comes up ready after a power cut.

## 5. Confirm it before a service

1. Launch the shortcut. Sign in.
2. Ring up **one item** and take payment.
3. Paper should emerge with no dialog.

Check on that first receipt:

- **Nothing is cut off** — the total and "Thank you for dining with us!" are both
  on the paper. If the bottom is missing, the driver is scaling; set it to 100% /
  "Actual size".
- **Nothing but the receipt** — no sidebar, no buttons, no dark background.
- **Both QR codes are solid and scannable**, not faint or striped.

Ring up a large order (15+ lines) once as well. A long receipt is where clipping
shows up, and it's better to find that now than mid-service.

## "I still get the print dialog"

Almost always one of these, in order of likelihood.

### Chrome was already running

This is the big one. **Chrome only reads command-line flags when it starts a new
process.** If any Chrome window is already open, launching the shortcut just asks
that existing process to open a tab, and every flag is silently discarded — no
error, it simply behaves normally.

`--user-data-dir` is what avoids this, because a different profile directory
forces a genuinely separate process. If you tried the flag without it, that's the
explanation.

To be certain: close **every** Chrome window, check Task Manager for leftover
`chrome.exe` processes and end them, then launch the shortcut.

### Confirm the flags actually arrived

In the kiosk window, open a new tab and go to:

```
chrome://version
```

Look at the **Command Line** row. `--kiosk-printing` must be listed there. If it
isn't, Chrome never received it and the problem is the shortcut, not the printer.

### The shortcut is malformed

Flags go *after* the closing quote of the executable path, separated by spaces:

```
"C:\...\chrome.exe" --kiosk-printing --user-data-dir="C:\pos-profile" --app=https://...
```

A flag inside the quotes becomes part of the path and Windows ignores it.

### You typed the URL into an ordinary window

The kiosk window is the only one that prints silently. A normal Chrome window
pointed at the same URL will always show the dialog — that's expected.

## "One bill came out with several cuts"

The cut must happen once, after the whole receipt has printed. Several cuts means
the receipt was split into several **pages**, and the printer cut at the end of
each one.

### First, find out which of the two causes it is

Don't guess — this test tells you in thirty seconds. In the primed Chrome profile,
open a long order from **Orders**, press 🖨, and in the print dialog change
**Destination** to **Save as PDF**. Save it and open the file.

| What the PDF shows | What's wrong | Fix |
|---|---|---|
| **Several pages** | Chrome is paginating — the paper size is too short | Paper length, below |
| **One page**, but paper still came out in pieces | Chrome sent one page; the printer is cutting mid-job | Cut mode, below |

Everything the app controls has already happened by this point, so one of these
two is always the answer.

### Cut mode

Most thermal drivers have a setting named something like *Cut Method*, *Paper
Cut* or *Auto Cut*, with options along the lines of:

- **Cut per page** — one cut at every page break. This is what chops a bill up.
- **Cut at end of document / end of job** — one cut per receipt. **Use this.**
- **None** — never cuts; tear it off by hand.

Control Panel → Devices and Printers → right-click the printer → **Printing
preferences**, then look under a tab like *Document Settings*, *Paper* or
*Advanced*. The exact wording varies by brand (XPrinter, Epson TM, Black Copper,
Rongta all name it differently).

### Black Copper BC858CG1 specifically

Black Copper ships a rebadged version of the common OEM 80mm POS driver (the same
family as XPrinter / Gainscha "POS-80"), so it behaves like those. Labels vary a
little between driver versions — if a name below doesn't match exactly, look for
the nearest equivalent.

**The paper size is the fix here** — `80 x 3276mm`, as in step 3 of the setup.
That was confirmed on a BC858CG1: with it selected, a long bill prints as one
strip with a single cut at the end. If you've landed in this section, check that
first.

**If it's already set and bills still come out in pieces**, then it's the cutter. On this driver family it usually sits in one of:

- Printing preferences → **Advanced** → *Cutter* / *Paper Cut*
- Printing preferences → a **Peripheral** or **Device Settings** tab
- Printer **Properties** (not Preferences) → **Device Settings**

Set it to cut at the **end of the document / job**, not per page.

**If the driver has no cutter option at all**, it's stored in the printer itself
rather than the driver. Black Copper bundles a utility — usually called *Printer
Test Tool* or *POS Printer Set Tool* — on the driver CD or their download page.
Connect over USB, open it, and set the cut mode there; it writes to the printer's
flash so it survives a reboot.

### Paper length (if no continuous size is offered)

The app asks for a page exactly as tall as the receipt, but that is only a
request — Chrome can only use a paper size the driver actually offers, and the
driver's default is often small. If none is long enough, make one:

1. Control Panel → **Devices and Printers**
2. Click any printer once, then **Print server properties** on the toolbar
3. **Forms** tab → tick **Create a new form**
4. Name it `Receipt 80x1000`, set **Width 8.00cm**, **Height 100.00cm**, margins 0
5. **Save Form**
6. Back in the printer's **Printing preferences**, choose `Receipt 80x1000` as the
   paper size

A page far longer than any receipt cannot paginate, so there is nothing to cut in
the middle of. A thermal printer only feeds what it prints, so the extra page
length costs no paper.

### While you're in there

Two settings make pagination more likely and are worth ruling out at the same time:

- **Scaling** must be **100% / Actual size**. "Fit to page" shrinks the text and
  can force a break.
- **Headers and footers** must be off (step 2 above). Chrome otherwise adds a URL
  and date line plus margins to every page, which is extra height on every receipt.

Test with a reprint from the Orders screen (🖨 on the row) rather than ringing up
another sale — same print path, no extra order in the books.

## Turning it off

Settings → **Print receipt automatically on payment**. Use it when the printer is
jammed or out of roll — sales continue as normal, and any order can be reprinted
later from the Orders screen (the 🖨 button on each row).


## Bluetooth mini printers (58mm pocket printers)

**Set the paper width first.** Settings → **Receipt paper width** → **58 mm**. The
bill is laid out at whatever is chosen here, so the preview on screen becomes
exactly what comes out of the machine — the date and the operator stack onto two
lines, the Qty and Amount columns get a gap, and nothing runs into the margin.
Leave it at 80 mm for a counter printer. Getting this wrong is the single most
common reason a receipt prints clipped down the right-hand edge.

**Then understand the one hard constraint.** This app prints through the
browser: it renders the receipt as a picture of a page and hands it to the
operating system. So the printer has to appear in **Printers & Scanners** as a
normal printer. Pairing it over Bluetooth is not enough on its own — pairing
gets the two devices talking, a driver is what lets anything print to it.

That splits Bluetooth mini printers into two kinds:

| | What happens |
|---|---|
| **Has a desktop driver** (most XPrinter / POS-58 / Goojprt / Rongta units) | Install it, the printer appears as a queue, and the app prints to it like any other. This is the case you want. |
| **App-only** (many no-name pocket printers sold for phones) | It only prints from the vendor's phone app over raw ESC/POS. The browser cannot reach it, and no setting in this app changes that. |

If yours is the second kind, the honest options are a USB or network thermal
printer at the counter, or a separate piece of work to speak ESC/POS to it
directly — which is a real project, not a setting.

### macOS — read this before you spend an evening on it

**Tested on the restaurant's own Black Copper Bluetooth printer, 3 Sep 2026.
It cannot be printed to from the browser on macOS.** Not a settings problem, and
not something this app can fix.

What the machine reports:

```
system_profiler SPBluetoothDataType   →  "BlueTooth Printer", Connected,
                                          Services: 0x802000 < Braille ACL >
/usr/libexec/cups/backend/bluetooth   →  Found device BlueTooth Printer
                                          No SDP record for BlueTooth Printer
lpstat -p                             →  the printer is NOT among the queues
lpinfo -v                             →  no bluetooth or usb device listed
```

The printer never advertises a Bluetooth printing service record, so macOS's own
CUPS Bluetooth backend refuses to build a print queue for it. No queue means the
browser has nothing to print to, and no driver install changes that — the driver
is the second half of a handshake whose first half never happens.

It is not unreachable, though. macOS exposes it as a serial port,
`/dev/cu.BlueToothPrinter`, and ESC/POS bytes written straight there print
immediately. That is what `scripts/print-thermal.mjs` does:

```
node scripts/print-thermal.mjs --dry              # see the bill in the terminal
node scripts/print-thermal.mjs --width 58         # print the newest paid bill
node scripts/print-thermal.mjs --order 172957     # print a specific one
```

Use it to prove the printer, the paper width and the bill layout. It is a bench
test, not the till's print path: it knows nothing about KOT slips, QR codes or
the FBR block, and nothing calls it during a sale.

**If the printer stops accepting data, the write hangs.** A thermal printer out
of paper, asleep, or out of Bluetooth range simply stops reading its serial
port. A process writing to it then blocks in an uninterruptible kernel wait —
state `U` in `ps` — and **cannot be killed**, not even with `kill -9`, until the
device lets go. Power-cycle the printer (or toggle Bluetooth off and on) and the
process dies on its own. `scripts/print-agent.mjs` guards against getting into
that state with a write deadline (`PRINT_WRITE_TIMEOUT_MS`, 15s by default), so
it reports a failure the till can fall back from instead of wedging; a raw
`printf > /dev/cu.…` has no such protection.

**So on a Mac, for a real till, use a USB or network thermal printer** — those
appear as ordinary queues and the browser prints to them normally. Keep the
Bluetooth unit for Windows (below), where it works properly.

### macOS, for a printer that DOES advertise itself

1. **Pair** — System Settings → Bluetooth, put the printer in pairing mode
   (usually hold the feed button until it flashes), connect.
2. **Install the driver** the printer came with. Search the model number plus
   "mac driver"; most 58mm units are rebadged POS-58 and take the common
   driver. Nothing to do here if the vendor ships a `.pkg`.
3. **Add it** — System Settings → Printers & Scanners → Add Printer. It should
   be listed under Default or Bluetooth. Choose the driver from step 2, not
   "Generic PostScript" — a thermal printer is not a PostScript device.
4. **Paper size** — in the print dialog, choose the 58mm roll size the driver
   offers (often `58 x 3276mm` or `Roll 58mm`). The long page is deliberate:
   3276mm is the ESC/POS maximum and a page that long cannot paginate, so
   there is never a mid-bill break for the cutter to act on.
5. **Test** — open any order in **Orders**, press the printer button, and print.

### Windows — this is where the Bluetooth printer belongs

Windows solves the problem macOS cannot: pairing a Bluetooth printer creates a
**virtual COM port**, and Black Copper's own driver binds a real printer queue
to it. Once there is a queue, everything in this document applies unchanged and
the browser prints to it like any other printer.

1. Settings → Bluetooth & devices → pair the printer.
2. Note the outgoing COM port it was given (Bluetooth settings → More Bluetooth
   options → COM Ports).
3. Install the Black Copper / POS-58 driver, choosing that COM port.
4. Set it as the Windows default printer and turn off "Let Windows manage my
   default printer" — `--kiosk-printing` always prints to the default.
5. Paper size: the 58mm roll the driver offers, scaling 100%, headers and
   footers off. Then prime the Chrome profile once (section 2) before switching
   on `--kiosk-printing` (section 3).

And set **Settings → Receipt paper width → 58 mm** in the app itself, or the
bill will be laid out for an 80mm roll and clipped down the right-hand side.

### If it prints but looks wrong

- **Cut off down the right side** — the paper width setting still says 80 mm,
  or the driver's paper size is wider than the roll.
- **Very small type with white space each side** — scaling is on "Fit to page".
  Set it to 100% / Actual size.
- **Comes out in pieces** — the paper length is too short, or the cutter is set
  to cut per page. Both are covered under "One bill came out with several cuts".
- **Nothing at all, no error** — the printer is paired but has no driver, so
  there is no queue for the browser to print to. Check Printers & Scanners: if
  it is not listed there, the app cannot see it.

## Notes and limits

- **Reprints** go through the same path, so they need no extra setup.
- **A receipt is one continuous strip.** There's no paper cut command — the app
  prints an image of a page, so cutting is whatever the printer does on its own.
- **Android tablets can't do this.** Chrome on Android has no `--kiosk-printing`.
  A tablet till needs either a print service that accepts silent jobs, or a
  Windows/Linux box driving the printer.
- **This is browser printing, not ESC/POS.** It renders the receipt as graphics,
  which is slower and uses more roll than sending text commands, but it needs no
  driver work and prints exactly what's on screen. Direct ESC/POS would be a
  separate piece of work — and it is the only way to reach a pocket printer that
  ships no desktop driver.
- **Paper width is a setting, not a constant.** Settings → Receipt paper width
  drives the preview, the print rules and the page size handed to the printer
  from one value, and the KOT slips follow it too. 58mm and 80mm are the two
  sizes offered because they are the two that are sold.
