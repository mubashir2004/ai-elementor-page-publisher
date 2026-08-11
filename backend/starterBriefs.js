/**
 * ============================================================
 * FILE: backend/starterBriefs.js
 *
 * A small library of ready-to-use, vertical-specific design
 * briefs. Each `brief` is a strong starting prompt the user can
 * drop into the generator and edit — so no one starts from a
 * blank box. Exposed via GET /api/starter-briefs.
 * ============================================================
 */

'use strict';

const STARTER_BRIEFS = [
  {
    id: 'local-service',
    name: 'Local service (locksmith / electrician)',
    vertical: 'Home services',
    brief:
      'Design a trust-forward landing page for "SecureKey Locksmith & Security", a licensed local locksmith and home-security company serving Austin. Sections: a bold hero with the phone number as a primary action + a "Free quote" button and a 5.0★ rating proof; a stat band (18+ years, 3,100+ jobs, 24/7 service, 100% satisfaction); six plainly-described services (emergency lockout, rekeying, key cutting, smart-lock install, home security, commercial access control); a "why choose us" block (licensed & insured, background-checked techs, upfront pricing); recent-work photos; three believable testimonials with names; and a contact section with hours, service area, and a map. Clean, confident, timeless — not a generic three-card template. Real copy, a real photo in every slot, one warm-amber accent.',
  },
  {
    id: 'dental-clinic',
    name: 'Dental clinic',
    vertical: 'Health & wellness',
    brief:
      'Design a calm, modern landing page for "Brightline Dental", a family and cosmetic dental practice. Sections: a reassuring hero with a "Book an appointment" CTA and a smiling patient photo; services grid (general checkups, cleanings, whitening, Invisalign, implants, emergency care) each with an icon and short description; a "meet the dentist" block with photo + credentials; new-patient offer band; insurance & financing note; patient testimonials with star ratings; FAQ accordion; and a contact section with hours, location, and a map. Soft, clinical, trustworthy palette (teal/mint), generous whitespace, real photography throughout.',
  },
  {
    id: 'hair-salon',
    name: 'Hair & beauty salon',
    vertical: 'Beauty',
    brief:
      'Design an elegant landing page for "Maison Rouge", an upscale hair and beauty salon. Sections: a full-bleed hero image with a "Book now" CTA; a services + price list (cut, color, balayage, styling, treatments, bridal); a stylist gallery; a before/after or portfolio carousel; a membership/offer band; glowing client testimonials; an Instagram-style image row; and a booking/contact section with hours and address. Editorial, feminine but not fussy — berry-rose accent, serif display headings over clean body text, real salon photography in every slot.',
  },
  {
    id: 'restaurant-cafe',
    name: 'Restaurant / café',
    vertical: 'Hospitality',
    brief:
      'Design an appetizing landing page for "Olive & Ember", a warm neighbourhood bistro. Sections: a mouth-watering hero food photo with "Reserve a table" and "View menu" buttons; an about-the-kitchen block with a chef/interior photo; menu highlights (starters, mains, desserts) with prices; a signature-dishes image gallery; opening hours + a reservations band; guest testimonials; and a contact section with address, phone, and a map. Warm terracotta/cream palette, Playfair-style headings, real food and interior photography — inviting, not corporate.',
  },
  {
    id: 'car-wash',
    name: 'Car wash & detailing',
    vertical: 'Automotive',
    brief:
      'Design a punchy landing page for "SplashPro Auto Spa", a premium car wash and detailing service. Sections: a high-energy hero of a gleaming car with a "Book a wash" CTA; a packages/pricing block (express, deluxe, full detail, ceramic coating) with feature lists and a "most popular" badge; a how-it-works 3-step process; a stat band (cars washed, years, 5★ reviews); before/after gallery; testimonials; and a location/hours contact section. Bold, clean, high-contrast with a bright accent (electric blue or hi-vis orange), real automotive photography throughout.',
  },
  {
    id: 'fitness-gym',
    name: 'Fitness gym / studio',
    vertical: 'Health & wellness',
    brief:
      'Design a high-energy landing page for "Ironline Strength", a modern gym and training studio. Sections: a powerful hero with a "Start free trial" CTA and a training photo; class/program cards (strength, HIIT, mobility, personal training); a membership pricing block with tiers; a trainer lineup with photos; a results/stat band (members, classes/week, transformations); testimonials; a schedule teaser; and a join/contact section. Charcoal + energetic lime/volt accent, bold condensed headings, real gym photography — motivating and confident.',
  },
  {
    id: 'saas-startup',
    name: 'SaaS / startup',
    vertical: 'Software',
    brief:
      'Design a clean, modern landing page for "Cadence", a B2B SaaS product that helps teams automate their reporting. Sections: a crisp hero with a one-line value prop, primary "Start free" + secondary "Book a demo" buttons, and a product screenshot/mockup image; a feature grid (3–4 icon cards) with benefit-led copy; a "how it works" 3-step section; a social-proof band with logos or a stat row; a pricing section with 3 tiers (Free / Pro / Business) and a highlighted plan; testimonials; an FAQ; and a final CTA band. Indigo/slate palette, Inter type, tight modern spacing, real UI-style imagery.',
  },
  {
    id: 'marketing-agency',
    name: 'Marketing agency',
    vertical: 'Professional services',
    brief:
      'Design a confident landing page for "BrandBuzz", a full-service digital marketing agency. Sections: a bold hero ("We create solutions for your business") with "Get started" + "Explore" buttons and an illustrative image; a services block of 4 cards (SEO/SEM, branding, social, paid ads) with colored icons; a numbered "simple solutions" process (contact → consult → plan → launch); an about/agency block with a results chart image and a 500+ projects stat; a client testimonials carousel; a full-width orange CTA band ("Ready to get started?"); and a footer with columns + social icons. Light, friendly, orange accent on navy text — compact spacing, real illustrations/photos, buttons everywhere they belong.',
  },
  {
    id: 'real-estate',
    name: 'Real-estate agency',
    vertical: 'Professional services',
    brief:
      'Design a polished landing page for "Northgate Realty", a local real-estate agency. Sections: a hero with a property/skyline photo, a headline, and "Browse listings" + "Free valuation" CTAs; a featured-listings image gallery with prices; a services block (buying, selling, renting, valuations); an about-the-team block with agent photos; a stat band (homes sold, avg. days on market, client rating); testimonials from happy buyers/sellers; and a contact section with office address and a map. Trustworthy navy/steel palette with a warm accent, real property photography in every slot.',
  },
  {
    id: 'law-firm',
    name: 'Law firm',
    vertical: 'Professional services',
    brief:
      'Design an authoritative landing page for "Whitmore & Associates", a boutique law firm. Sections: a serious, reassuring hero with a "Request a consultation" CTA and an office/portrait photo; practice-area cards (family, business, real estate, estate planning); a "why our clients trust us" block with credentials and case-result stats; attorney profiles with photos; testimonials; an FAQ; and a contact section with office hours, address, and a map. Restrained, professional palette (deep slate + a single refined accent), serif or strong grotesque headings, generous whitespace, real professional photography.',
  },
  {
    id: 'creative-portfolio',
    name: 'Creative portfolio',
    vertical: 'Creative',
    brief:
      'Design a striking personal portfolio landing page for "Lena Ortiz", a freelance product designer. Sections: a type-first hero with a short intro and a "View work" CTA; a selected-projects gallery with hover detail; an about block with a portrait and a short story; a skills/services list; a client-logos or testimonials strip; and a contact/hire-me section with email and social links. High-contrast, confident, editorial composition with a single bold accent and expressive display type — asymmetry and scale contrast, not a centered template. Real project imagery in every slot.',
  },
  {
    id: 'ecommerce-store',
    name: 'E-commerce store',
    vertical: 'Retail',
    brief:
      'Design an inviting landing page for "Terra Goods", a small-batch home & lifestyle store. Sections: a lifestyle hero with a "Shop now" CTA; a featured-products grid (image, name, price) with a hover CTA; category tiles; a brand-story block with a photo; a benefits band (free shipping, easy returns, sustainably made) with icons; customer reviews with star ratings; an email-signup band; and a footer with shop links + social. Warm, tactile palette, clean product photography, tidy modern spacing — feels like a real boutique storefront.',
  },
];

module.exports = { STARTER_BRIEFS };
