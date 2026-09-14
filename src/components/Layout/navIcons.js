import {
    Utensils, ClipboardList, BarChart3, ExternalLink, User,
    MonitorPlay, Settings, Wallet, CalendarCheck, ReceiptText, Building2,
    Percent, BadgePercent, Package, BookText, Armchair, Users,
    Receipt, CalendarDays, Clock, Boxes, PieChart, TrendingUp,
    Landmark, Truck, ChefHat, PackageCheck, FileStack, ClipboardCheck,
    Calculator, BookOpen, ScrollText, Files, FilePlus2, FolderOpen, Hash,
    FileSpreadsheet, Scale, Banknote, HeartPulse,
    UtensilsCrossed, Tags, Layers, SlidersHorizontal, Carrot, Trash2, Share2, Palette,
    Circle,
} from 'lucide-react';

/*
 * Names to glyphs, kept here rather than in `src/lib/navIndex.mjs`.
 *
 * The index is plain data — no imports, no JSX — which is what lets a plain
 * Node test read the real thing and assert that "z report" still finds the
 * Handover Report. Bolting an icon component onto each row would have made the
 * nav data drag a rendering library behind it and put the keywords beyond the
 * reach of the test suite.
 */
const ICONS = {
    Utensils, ClipboardList, BarChart3, ExternalLink, User,
    MonitorPlay, Settings, Wallet, CalendarCheck, ReceiptText, Building2,
    Percent, BadgePercent, Package, BookText, Armchair, Users,
    Receipt, CalendarDays, Clock, Boxes, PieChart, TrendingUp,
    Landmark, Truck, ChefHat, PackageCheck, FileStack, ClipboardCheck,
    Calculator, BookOpen, ScrollText, Files, FilePlus2, FolderOpen, Hash,
    FileSpreadsheet, Scale, Banknote, HeartPulse,
    UtensilsCrossed, Tags, Layers, SlidersHorizontal, Carrot, Trash2, Share2, Palette,
};

/* A missing glyph must never take a nav row down with it. */
export const navIcon = (name) => ICONS[name] || Circle;
