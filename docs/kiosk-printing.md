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
  separate piece of work.
