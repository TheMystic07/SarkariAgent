export interface ServiceField {
  key: string;
  label: string;
  required: boolean;
  hint?: string;
}

export interface ServiceUpload {
  label: string;
  format: string;
  maxKb: number;
  note?: string;
}

export interface ServiceDef {
  id: string;
  name: string;
  authority: string;
  portal: string;
  fee: string;
  fields: ServiceField[];
  documents: string[];
  uploads: ServiceUpload[];
  submissionSteps: string[];
  notes?: string;
}

export const SERVICES: ServiceDef[] = [
  {
    id: "pan-new",
    name: "New PAN Card (Form 49A)",
    authority: "Income Tax Department (via Protean / UTIITSL)",
    portal: "https://www.onlineservices.nsdl.com/paam/endUserRegisterContact.html",
    fee: "~₹107 (physical card) / ~₹72 (e-PAN only); free instant e-PAN via incometax.gov.in with Aadhaar",
    fields: [
      { key: "full_name", label: "Full name (as on Aadhaar)", required: true },
      { key: "father_name", label: "Father's full name", required: true },
      { key: "dob", label: "Date of birth (DD/MM/YYYY)", required: true },
      { key: "gender", label: "Gender", required: true },
      { key: "aadhaar_number", label: "Aadhaar number", required: true, hint: "Needed for e-KYC; store masked, confirm only last 4 digits" },
      { key: "mobile", label: "Mobile number (linked to Aadhaar for OTP)", required: true },
      { key: "email", label: "Email address", required: true },
      { key: "address_line", label: "Address (house/street/locality)", required: true },
      { key: "city_district", label: "City / District", required: true },
      { key: "state", label: "State", required: true },
      { key: "pincode", label: "PIN code", required: true },
      { key: "income_source", label: "Source of income", required: false, hint: "Salary / Business / No income etc." },
    ],
    documents: [
      "Aadhaar card (covers identity, address and DOB proof in the e-KYC flow)",
      "Photograph (only for physical/scan mode; e-KYC uses Aadhaar photo)",
      "Signature (scan mode only)",
    ],
    uploads: [
      { label: "Photograph", format: "JPEG", maxKb: 50, note: "3.5cm x 2.5cm; only needed in scanned-document mode" },
      { label: "Signature", format: "JPEG", maxKb: 50, note: "scanned-document mode only" },
    ],
    submissionSteps: [
      "Easiest path: incometax.gov.in → 'Instant e-PAN' → enter Aadhaar → OTP on Aadhaar-linked mobile (free, ~10 minutes).",
      "For a physical card: open the Protean (NSDL) 49A form, choose Aadhaar e-KYC mode.",
      "Fill the form using the details I've collected — I'll give you a field-by-field cheat sheet.",
      "Enter the Aadhaar OTP yourself when the portal asks (I never handle OTPs).",
      "Pay the fee online and save the acknowledgement number; I can track the checklist for you.",
    ],
    notes: "If the user has no Aadhaar-linked mobile, the scanned-document mode is required — then photo/signature uploads and their KB limits apply. Upload limits change occasionally; verify on the portal.",
  },
  {
    id: "voter-new",
    name: "New Voter ID (Form 6)",
    authority: "Election Commission of India",
    portal: "https://voters.eci.gov.in",
    fee: "Free",
    fields: [
      { key: "full_name", label: "Full name", required: true },
      { key: "relative_name", label: "Father/Mother/Husband's name", required: true },
      { key: "relation_type", label: "Relation (father/mother/husband/wife/guardian)", required: true },
      { key: "dob", label: "Date of birth (DD/MM/YYYY)", required: true },
      { key: "gender", label: "Gender", required: true },
      { key: "mobile", label: "Mobile number", required: true },
      { key: "email", label: "Email", required: false },
      { key: "aadhaar_number", label: "Aadhaar number", required: false, hint: "Optional under Form 6B; store masked" },
      { key: "house_no", label: "House number", required: true },
      { key: "street", label: "Street / Area / Locality", required: true },
      { key: "village_town", label: "Village / Town", required: true },
      { key: "district", label: "District", required: true },
      { key: "state", label: "State / UT", required: true },
      { key: "pincode", label: "PIN code", required: true },
    ],
    documents: [
      "Recent passport-size colour photograph",
      "Address proof (Aadhaar / utility bill / bank passbook / rent agreement)",
      "Age proof (Aadhaar / birth certificate / class 10 marksheet) — needed if age 18-21",
    ],
    uploads: [
      { label: "Photograph", format: "JPEG/PNG", maxKb: 200, note: "portal limits have varied between 200KB and 2MB — verify on the upload screen" },
      { label: "Address proof scan", format: "JPEG/PDF", maxKb: 2048 },
      { label: "Age proof scan", format: "JPEG/PDF", maxKb: 2048 },
    ],
    submissionSteps: [
      "Create an account on voters.eci.gov.in with your mobile number (OTP done by you).",
      "Open 'Fill Form 6' (new elector). Select your state, district and assembly constituency.",
      "Fill the form using the cheat sheet I prepare from your saved details.",
      "Upload the photo and document scans (I'll pre-compress them to fit the limits).",
      "Submit and note the reference number — you can track status on the same portal; a BLO may visit for verification.",
    ],
  },
  {
    id: "learner-licence",
    name: "Learner's Licence (LL)",
    authority: "Ministry of Road Transport (Sarathi Parivahan)",
    portal: "https://sarathi.parivahan.gov.in",
    fee: "~₹150 fee + ~₹50 test fee (varies by state)",
    fields: [
      { key: "full_name", label: "Full name", required: true },
      { key: "father_name", label: "Father/Guardian name", required: true },
      { key: "dob", label: "Date of birth (DD/MM/YYYY)", required: true },
      { key: "gender", label: "Gender", required: true },
      { key: "blood_group", label: "Blood group", required: false },
      { key: "mobile", label: "Mobile number", required: true },
      { key: "email", label: "Email", required: false },
      { key: "address_line", label: "Present address", required: true },
      { key: "district", label: "District", required: true },
      { key: "state", label: "State", required: true },
      { key: "pincode", label: "PIN code", required: true },
      { key: "vehicle_class", label: "Vehicle class", required: true, hint: "MCWG (motorcycle) / LMV (car) / both" },
    ],
    documents: [
      "Age & address proof (Aadhaar works for both)",
      "Passport-size photograph",
      "Signature scan",
      "Medical certificate Form 1 (self-declaration; Form 1A for transport vehicles/age 40+)",
    ],
    uploads: [
      { label: "Photograph", format: "JPEG", maxKb: 200, note: "some state RTOs require specific pixel sizes" },
      { label: "Signature", format: "JPEG", maxKb: 50 },
      { label: "Document scans", format: "PDF/JPEG", maxKb: 500 },
    ],
    submissionSteps: [
      "Open sarathi.parivahan.gov.in → select your state → 'Apply for Learner Licence'.",
      "Many states support faceless Aadhaar e-KYC — OTP entered by you.",
      "Fill the application with the cheat sheet I prepare; upload pre-compressed photo/signature.",
      "Pay the fee, then book the LL test slot (online test in faceless states).",
      "Take the online test; the LL PDF is downloadable after passing.",
    ],
  },
  {
    id: "aadhaar-update",
    name: "Aadhaar Address Update (online)",
    authority: "UIDAI",
    portal: "https://myaadhaar.uidai.gov.in",
    fee: "₹50 (online document update)",
    fields: [
      { key: "aadhaar_number", label: "Aadhaar number", required: true, hint: "Store masked; needed to log in" },
      { key: "mobile", label: "Aadhaar-linked mobile (for OTP)", required: true },
      { key: "house_no", label: "New address: house number", required: true },
      { key: "street", label: "New address: street / locality", required: true },
      { key: "village_town", label: "New address: village / town / city", required: true },
      { key: "district", label: "New address: district", required: true },
      { key: "state", label: "New address: state", required: true },
      { key: "pincode", label: "New address: PIN code", required: true },
    ],
    documents: [
      "One valid address proof: utility bill (<3 months), bank passbook, rent agreement (registered), passport, etc.",
    ],
    uploads: [
      { label: "Address proof scan", format: "JPEG/PNG/PDF", maxKb: 2048, note: "clear, colour, all corners visible" },
    ],
    submissionSteps: [
      "Log in at myaadhaar.uidai.gov.in with Aadhaar number + OTP (you enter the OTP).",
      "Open 'Address Update' → 'Update Aadhaar Online'.",
      "Enter the new address exactly as in the cheat sheet I prepare.",
      "Upload the address proof (I'll pre-compress/convert it).",
      "Pay ₹50 online and save the URN (Update Request Number) to track status.",
    ],
    notes:
      "Only ADDRESS can be updated fully online. Name (minor change), DOB, gender have limits and may require an Aadhaar Seva Kendra visit; photo/biometrics always require a centre visit — I can help book that appointment slot info instead.",
  },
  {
    id: "aadhaar-download",
    name: "Download e-Aadhaar (PDF)",
    authority: "UIDAI",
    portal: "https://myaadhaar.uidai.gov.in",
    fee: "Free",
    fields: [
      { key: "aadhaar_number", label: "Aadhaar number (or EID if not known)", required: true, hint: "Store masked" },
      { key: "mobile", label: "Aadhaar-linked mobile (for OTP)", required: true },
      { key: "full_name", label: "Name as on Aadhaar", required: true, hint: "Needed to tell the user their PDF password" },
      { key: "dob", label: "Year of birth", required: true, hint: "PDF password = first 4 letters of name (CAPS) + birth year" },
    ],
    documents: [],
    uploads: [],
    submissionSteps: [
      "Go to myaadhaar.uidai.gov.in → 'Download Aadhaar'.",
      "Enter Aadhaar number (or EID) + captcha, then the OTP sent to the linked mobile (you enter both).",
      "Download the PDF. Password = first 4 letters of your name in CAPITALS + your birth year (e.g. RAHU1998).",
      "Optionally choose 'Masked Aadhaar' for a safer shareable copy.",
    ],
    notes: "If the user's mobile is not linked to Aadhaar, online download is impossible — they must visit an Aadhaar Seva Kendra.",
  },
  {
    id: "ssc-otr",
    name: "SSC One-Time Registration (job applications)",
    authority: "Staff Selection Commission",
    portal: "https://ssc.gov.in",
    fee: "Registration free; exam fees vary (~₹100, many categories exempt)",
    fields: [
      { key: "full_name", label: "Full name (as on matric certificate)", required: true },
      { key: "father_name", label: "Father's name", required: true },
      { key: "mother_name", label: "Mother's name", required: true },
      { key: "dob", label: "Date of birth (as on matric certificate)", required: true },
      { key: "gender", label: "Gender", required: true },
      { key: "category", label: "Category (UR/OBC/SC/ST/EWS)", required: true },
      { key: "matric_board", label: "Class 10 board name", required: true },
      { key: "matric_roll", label: "Class 10 roll number", required: true },
      { key: "matric_year", label: "Class 10 passing year", required: true },
      { key: "highest_qualification", label: "Highest qualification", required: true },
      { key: "mobile", label: "Mobile number", required: true },
      { key: "email", label: "Email", required: true },
      { key: "aadhaar_number", label: "Aadhaar number (recommended ID)", required: false, hint: "Store masked" },
      { key: "address_line", label: "Permanent address", required: true },
      { key: "district", label: "District", required: true },
      { key: "state", label: "State", required: true },
      { key: "pincode", label: "PIN code", required: true },
    ],
    documents: ["Class 10 certificate (for exact name/DOB)", "Photo ID (Aadhaar recommended)", "Recent photograph", "Signature"],
    uploads: [
      { label: "Photograph", format: "JPEG", maxKb: 50, note: "recent (within 3 months), 20-50KB, plain background — SSC rejects old photos" },
      { label: "Signature", format: "JPEG", maxKb: 20, note: "10-20KB, black/blue ink on white paper" },
    ],
    submissionSteps: [
      "Go to ssc.gov.in → 'Register Now' (One-Time Registration).",
      "Fill personal, matric and contact details from the cheat sheet — matric details must EXACTLY match the class 10 certificate.",
      "Verify mobile and email via OTP (you enter them).",
      "Upload the pre-compressed photo and signature.",
      "Save your registration number and password — every future SSC exam application uses this OTR.",
    ],
  },
  {
    id: "ncs-registration",
    name: "National Career Service — Jobseeker Registration",
    authority: "Ministry of Labour & Employment",
    portal: "https://www.ncs.gov.in",
    fee: "Free",
    fields: [
      { key: "full_name", label: "Full name", required: true },
      { key: "dob", label: "Date of birth", required: true },
      { key: "gender", label: "Gender", required: true },
      { key: "mobile", label: "Mobile number", required: true },
      { key: "email", label: "Email", required: false },
      { key: "highest_qualification", label: "Highest qualification", required: true },
      { key: "key_skills", label: "Key skills / trade", required: true, hint: "e.g. data entry, electrician, nursing" },
      { key: "state", label: "State", required: true },
      { key: "district", label: "District", required: true },
    ],
    documents: ["None mandatory to register; education certificates help profile strength"],
    uploads: [],
    submissionSteps: [
      "Go to ncs.gov.in → 'Jobseeker' → sign up (mobile OTP entered by you).",
      "Complete the profile with the details from the cheat sheet.",
      "Search and apply to listed government and private jobs; NCS also lists free career counselling and job fairs nearby.",
    ],
  },
];

export function getService(id: string): ServiceDef | undefined {
  return SERVICES.find((s) => s.id === id);
}

export function listServices(): { id: string; name: string; fee: string }[] {
  return SERVICES.map(({ id, name, fee }) => ({ id, name, fee }));
}
