-- What one outlet does differently from the company (14 Sep 2026). Re-runnable.
--
-- Blink keeps twenty-five settings PER BRANCH and copies every one of them to
-- every outlet. That is the wrong shape here for the same reason a second menu
-- would be: the fields drift. Open a third branch and someone has to remember
-- to set twenty-five things, and the one they forget is silently wrong rather
-- than loudly missing.
--
-- So this holds ONLY THE DIFFERENCES, exactly like branch_menu_items. Every
-- column is NULLable and NULL means "whatever the company says". A single
-- outlet needs no row at all and nothing about it changes.
--
-- WHAT EARNS A PLACE HERE — a setting belongs per branch only if two outlets
-- of the SAME restaurant would genuinely answer it differently:
--
--   tax      A branch in Lahore answers to the Punjab Revenue Authority, one
--            in Karachi to the Sindh Revenue Board, one in Islamabad to the
--            FBR, and their rates differ. This is the field that makes the
--            table worth having.
--   FBR      Each outlet registers its OWN POS with the authority and gets its
--            own POS ID and token. Sharing one across two branches files both
--            outlets' invoices under one registration, which is a tax problem,
--            not a software one.
--   receipt  The address and phone printed on the bill are the address and
--            phone of the outlet that printed it. Never head office's.
--   the day  Trading hours differ: a mall branch closes when the mall does.
--   the till Different floats, different tolerance for a short drawer.
--
-- WHAT DOES NOT — the brand colour, the logo, how a KOT is split, whether the
-- drawer kicks, tokens, rounding: those are decisions about what the company
-- IS, and an outlet that answered them differently would just look broken.
-- They stay in store_settings, one answer for everybody.
CREATE TABLE IF NOT EXISTS branch_settings (
    branch_id      INT NOT NULL,

    -- NULL here means the company rate, so raising GST once still reaches
    -- every outlet that has not deliberately departed from it.
    tax_rate_cash  DECIMAL(5,4) NULL,
    tax_rate_card  DECIMAL(5,4) NULL,
    -- 'GST', 'PST', 'Sales Tax' — printed on the bill, so it follows the rate.
    tax_label      VARCHAR(32)  NULL,
    -- Which authority this outlet files to. Drives nothing but the label and
    -- the operator's own understanding today; it is recorded because getting
    -- it wrong later is expensive and it costs nothing to ask now.
    tax_authority  VARCHAR(8)   NULL,

    -- This outlet's own registration. Kept NULL where the company's env-level
    -- credentials are the right ones, which is the single-branch case.
    fbr_pos_id     VARCHAR(32)  NULL,
    fbr_ntn        VARCHAR(32)  NULL,

    -- Printed under the total: return policy, a delivery note, a WhatsApp
    -- number. Outlets say different things here.
    receipt_footer VARCHAR(255) NULL,

    day_start_time TIME NULL,
    day_end_time   TIME NULL,

    opening_float       DECIMAL(12,2) NULL,
    variance_tolerance  DECIMAL(12,2) NULL,

    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    PRIMARY KEY (branch_id),
    CONSTRAINT fk_bset_branch FOREIGN KEY (branch_id) REFERENCES branches (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

/*
 * The FBR token is the one field that does NOT go in this table. It is a
 * credential, it is server-env only by the project's own rule, and a column
 * holding it would be read by every screen that reads a settings row. A
 * second outlet supplies its token as FBR_TOKEN_<branch id> in the server
 * environment, which is where the first one's already lives.
 */
