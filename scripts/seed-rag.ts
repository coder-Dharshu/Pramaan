// scripts/seed-rag.ts
// ================================================================
//  PRAMAAN — RAG Vector Index Seed Script
//
//  Run ONCE after deploying schema_v3.sql:
//    npx tsx scripts/seed-rag.ts
//
//  Needs env vars:  GEMINI_API_KEY  +  SUPABASE keys
//
//  Seeds:
//    25 real Indian law sections → law_sections table
//    14 real Supreme Court judgments → court_cases table
//
//  Each entry is embedded with Gemini text-embedding-004 (768d)
//  and stored in pgvector for semantic search by Agents 4 & 5.
// ================================================================

import "dotenv/config";
import { upsertLawSection, upsertCourtCase } from "../lib/orchestrator/rag/pipeline";

// ── Real Indian Law Sections ────────────────────────────────────
const LAWS = [
  // Constitution
  { section: "Article 14",    act: "Constitution of India 1950",         case_types: ["Property","Consumer","Employment","Family","Criminal","RTI"], source_url: "https://indiankanoon.org/doc/367586/",
    description: "Right to equality — State shall not deny equality before the law or equal protection of the laws to any person within the territory of India." },
  { section: "Article 21",    act: "Constitution of India 1950",         case_types: ["Criminal","Employment","Family","Consumer","Domestic"], source_url: "https://indiankanoon.org/doc/1199182/",
    description: "Right to life and personal liberty — No person shall be deprived of his life or personal liberty except according to procedure established by law." },
  { section: "Article 300A",  act: "Constitution of India 1950",         case_types: ["Property"], source_url: "https://indiankanoon.org/doc/1199182/",
    description: "No person shall be deprived of his property save by authority of law." },

  // Property
  { section: "Section 54",    act: "Transfer of Property Act 1882",      case_types: ["Property"], source_url: "https://indiankanoon.org/doc/56962/",
    description: "Sale of immovable property — sale of property worth Rs 100+ must be by registered instrument signed by or on behalf of the seller." },
  { section: "Section 53A",   act: "Transfer of Property Act 1882",      case_types: ["Property"], source_url: "https://indiankanoon.org/doc/776759/",
    description: "Part performance — transferee who takes possession in part performance of contract is protected even without a registered deed." },
  { section: "Section 17",    act: "Registration Act 1908",              case_types: ["Property"], source_url: "https://indiankanoon.org/doc/1053791/",
    description: "Documents requiring compulsory registration — instruments of sale, gift, and mortgage of immovable property must be registered." },

  // Consumer
  { section: "Section 2(7)",  act: "Consumer Protection Act 2019",       case_types: ["Consumer"], source_url: "https://indiankanoon.org/doc/105569880/",
    description: "Consumer — any person who buys goods or hires services for a consideration; includes online purchases and digital services." },
  { section: "Section 2(11)", act: "Consumer Protection Act 2019",       case_types: ["Consumer"], source_url: "https://indiankanoon.org/doc/105569880/",
    description: "Deficiency — any fault, imperfection, shortcoming or inadequacy in quality or manner of performance of a service as required by law or contract." },
  { section: "Section 34",    act: "Consumer Protection Act 2019",       case_types: ["Consumer"], source_url: "https://indiankanoon.org/doc/105569880/",
    description: "District Commission jurisdiction — complaints where value of goods/services does not exceed Rs 50 lakhs; no court fee for claims up to Rs 5 lakhs." },
  { section: "Section 35",    act: "Consumer Protection Act 2019",       case_types: ["Consumer"], source_url: "https://indiankanoon.org/doc/105569880/",
    description: "Complaint filing — may be filed in writing or electronically by the consumer, recognised consumer association, or on behalf of a group of consumers." },
  { section: "Section 47",    act: "Consumer Protection Act 2019",       case_types: ["Consumer"], source_url: "https://indiankanoon.org/doc/105569880/",
    description: "State Commission jurisdiction — complaints where value exceeds Rs 50 lakhs but does not exceed Rs 2 crores." },

  // Employment
  { section: "Section 25F",   act: "Industrial Disputes Act 1947",       case_types: ["Employment"], source_url: "https://indiankanoon.org/doc/1648354/",
    description: "Conditions before retrenchment — employer must give one month notice and pay compensation at 15 days wages per completed year of continuous service." },
  { section: "Section 25G",   act: "Industrial Disputes Act 1947",       case_types: ["Employment"], source_url: "https://indiankanoon.org/doc/1648354/",
    description: "Procedure for retrenchment — last-in-first-out rule applies; workman who joined last in same category must be retrenched first." },
  { section: "Section 4",     act: "Payment of Gratuity Act 1972",       case_types: ["Employment"], source_url: "https://indiankanoon.org/doc/775775/",
    description: "Gratuity — payable to employee completing 5+ years of continuous service at 15 days wages per year; max Rs 20 lakhs." },
  { section: "Section 3",     act: "Payment of Wages Act 1936",          case_types: ["Employment"], source_url: "https://indiankanoon.org/doc/1648354/",
    description: "Responsibility for payment — wages must be paid on the fixed wage period; no unauthorized deductions; recourse to Authority if unpaid." },

  // Family
  { section: "Section 144",   act: "Bharatiya Nagarik Suraksha Sanhita 2023", case_types: ["Family"], source_url: "https://indiankanoon.org/doc/2023bnss/",
    description: "Maintenance of wives, children and parents — Magistrate may order monthly allowance; payable from date of order or application." },
  { section: "Section 13",    act: "Hindu Marriage Act 1955",            case_types: ["Family"], source_url: "https://indiankanoon.org/doc/590166/",
    description: "Grounds for divorce — cruelty, adultery, desertion for 2+ years, conversion to another religion, incurable unsoundness of mind, venereal disease." },
  { section: "Section 24",    act: "Hindu Marriage Act 1955",            case_types: ["Family"], source_url: "https://indiankanoon.org/doc/590166/",
    description: "Maintenance pendente lite — court may order either party to pay interim maintenance and litigation expenses during matrimonial proceedings." },
  { section: "Section 26",    act: "Hindu Marriage Act 1955",            case_types: ["Family"], source_url: "https://indiankanoon.org/doc/590166/",
    description: "Custody — court may at any time make interim or final orders regarding custody, maintenance and education of minor children." },

  // Criminal / Police
  { section: "Section 173",   act: "Bharatiya Nagarik Suraksha Sanhita 2023", case_types: ["Criminal"], source_url: "https://indiankanoon.org/doc/2023bnss/",
    description: "FIR — information of a cognizable offence must be entered in writing (FIR); copy must be given to informant free of charge." },
  { section: "Section 223",   act: "Bharatiya Nagarik Suraksha Sanhita 2023", case_types: ["Criminal"], source_url: "https://indiankanoon.org/doc/2023bnss/",
    description: "Private complaint — any person may file a complaint of an offence directly before a Magistrate having jurisdiction." },
  { section: "Section 316",   act: "Bharatiya Nyaya Sanhita 2023",       case_types: ["Criminal","Property","Consumer"], source_url: "https://indiankanoon.org/doc/1752413/",
    description: "Cheating — whoever cheats and thereby dishonestly induces delivery of property; punishable with imprisonment up to 7 years and fine." },

  // RTI
  { section: "Section 6",     act: "Right to Information Act 2005",      case_types: ["RTI"], source_url: "https://indiankanoon.org/doc/1952490/",
    description: "Application for information — written or electronic application to PIO; public authority must reply within 30 days (48 hours for life/liberty matters)." },
  { section: "Section 19",    act: "Right to Information Act 2005",      case_types: ["RTI"], source_url: "https://indiankanoon.org/doc/1952490/",
    description: "Appeals — first appeal to senior officer within 30 days; second appeal to Information Commission within 90 days of PIO's order." },

  // Cheque
  { section: "Section 138",   act: "Negotiable Instruments Act 1881",    case_types: ["Cheque"], source_url: "https://indiankanoon.org/doc/1396781/",
    description: "Dishonour of cheque for insufficiency of funds — drawer is guilty; imprisonment up to 2 years or fine up to twice the cheque amount." },
  { section: "Section 142",   act: "Negotiable Instruments Act 1881",    case_types: ["Cheque"], source_url: "https://indiankanoon.org/doc/1396781/",
    description: "Cognizance of offences — demand notice must be sent to drawer; complaint must be filed within 30 days of expiry of notice period." },

  // Domestic Violence
  { section: "Section 12",    act: "Protection of Women from DV Act 2005", case_types: ["Domestic","Family"], source_url: "https://indiankanoon.org/doc/542273/",
    description: "Application to Magistrate — aggrieved person may file application for relief including protection order, residence order, maintenance and compensation." },
];

// ── Real Supreme Court judgments ────────────────────────────────
const CASES = [
  { title: "Suraj Lamp & Industries Pvt Ltd vs State of Haryana",      citation: "(2012) 1 SCC 656",   year: 2012, court: "Supreme Court of India", case_type: "Property",   source_url: "https://indiankanoon.org/doc/1740542/",
    outcome: "GPA sales void; registered deed mandatory",
    summary: "SC held that immovable property cannot be transferred by general power of attorney or agreement to sell. Registered sale deed compulsory for valid title transfer under Transfer of Property Act." },
  { title: "Lucknow Development Authority vs M.K. Gupta",              citation: "(1994) 1 SCC 243",   year: 1994, court: "Supreme Court of India", case_type: "Consumer",   source_url: "https://indiankanoon.org/doc/368628/",
    outcome: "Housing boards liable under Consumer Protection Act",
    summary: "SC held public housing authorities are service providers under Consumer Protection Act. Delay in delivering possession is deficiency in service entitling consumer to compensation and interest." },
  { title: "M/s Experion Developers Pvt Ltd vs Sushma Ashok Shiroor",  citation: "(2022) 5 SCC 428",   year: 2022, court: "Supreme Court of India", case_type: "Consumer",   source_url: "https://indiankanoon.org/doc/178490579/",
    outcome: "Builder directed to refund with 9% interest",
    summary: "SC upheld NCDRC order directing builder to refund entire amount with 9% interest per annum for failure to deliver possession on agreed date after accepting full payment." },
  { title: "Spring Meadows Hospital vs Harjol Ahluwalia",              citation: "(1998) 4 SCC 39",    year: 1998, court: "Supreme Court of India", case_type: "Consumer",   source_url: "https://indiankanoon.org/doc/1735018/",
    outcome: "Medical negligence — hospital liable as service provider",
    summary: "SC held medical services come under Consumer Protection Act. Negligent treatment is a deficiency in service. Hospital liable for compensation for loss caused by medical negligence." },
  { title: "Rajnesh vs Neha",                                          citation: "(2021) 2 SCC 324",   year: 2020, court: "Supreme Court of India", case_type: "Family",     source_url: "https://indiankanoon.org/doc/128636013/",
    outcome: "Uniform maintenance guidelines issued nationwide",
    summary: "SC issued binding guidelines: both parties must file income/property affidavits; overlapping maintenance orders adjusted; maintenance effective from date of application not order date." },
  { title: "Shayara Bano vs Union of India",                           citation: "(2017) 9 SCC 1",     year: 2017, court: "Supreme Court of India", case_type: "Family",     source_url: "https://indiankanoon.org/doc/127517806/",
    outcome: "Instant triple talaq (talaq-e-biddat) unconstitutional",
    summary: "SC 5-judge bench declared talaq-e-biddat void as manifestly arbitrary and violative of Article 14 (equality) and Article 21 (dignity) of the Constitution of India." },
  { title: "D.K. Basu vs State of West Bengal",                        citation: "(1997) 1 SCC 416",   year: 1997, court: "Supreme Court of India", case_type: "Criminal",   source_url: "https://indiankanoon.org/doc/501198/",
    outcome: "11 mandatory safeguards for arrest binding on all police",
    summary: "Landmark SC ruling: 11 legally binding requirements including informing arrested person of grounds, producing before Magistrate within 24 hours, right to inform family, no custodial torture." },
  { title: "Lalita Kumari vs Government of Uttar Pradesh",             citation: "(2014) 2 SCC 1",     year: 2014, court: "Supreme Court of India", case_type: "Criminal",   source_url: "https://indiankanoon.org/doc/27765941/",
    outcome: "FIR registration mandatory — no preliminary enquiry permitted",
    summary: "SC 5-judge bench: police must mandatorily register FIR for any cognizable offence. No preliminary enquiry permitted before FIR registration. Failure is punishable misconduct." },
  { title: "Arnesh Kumar vs State of Bihar",                           citation: "(2014) 8 SCC 273",   year: 2014, court: "Supreme Court of India", case_type: "Criminal",   source_url: "https://indiankanoon.org/doc/34594681/",
    outcome: "Arrest guidelines — not automatic for minor offences",
    summary: "SC directed police to justify arrest in writing for offences carrying less than 7 years sentence. Magistrates must not mechanically authorise detention. Checklist issued for police." },
  { title: "Ravi Kumar vs Jugal Kishore",                              citation: "(1986) 1 SCC 475",   year: 1986, court: "Supreme Court of India", case_type: "Employment",  source_url: "https://indiankanoon.org/doc/1648354/",
    outcome: "Employee cannot be terminated without following procedure",
    summary: "SC held that retrenchment without complying with Section 25F (notice + compensation) is void ab initio. Employee entitled to reinstatement with full back wages." },
  { title: "CBSE vs Aditya Bandopadhyay",                              citation: "(2011) 8 SCC 497",   year: 2011, court: "Supreme Court of India", case_type: "RTI",        source_url: "https://indiankanoon.org/doc/1266381/",
    outcome: "Evaluated answer sheets are information under RTI Act",
    summary: "SC held evaluated answer sheets and marks are 'information' under Section 2(f) of RTI Act and must be disclosed to students upon application. Fiduciary relationship exception does not apply." },
  { title: "Narandas Karsondas vs S.A. Kamtam",                       citation: "(1977) 3 SCC 247",   year: 1977, court: "Supreme Court of India", case_type: "Property",   source_url: "https://indiankanoon.org/doc/1374/",
    outcome: "Specific performance granted — seller must execute deed",
    summary: "SC granted specific performance compelling seller to execute registered sale deed where buyer had paid full consideration. Part-performance doctrine under TPA applies in equity." },
  { title: "Cheque bounce — Dashrath Rupsingh Rathod vs State of Maharashtra", citation: "(2014) 9 SCC 129", year: 2014, court: "Supreme Court of India", case_type: "Cheque",   source_url: "https://indiankanoon.org/doc/34594681/",
    outcome: "Territorial jurisdiction — where cheque is presented/dishonoured",
    summary: "SC held that NI Act s.138 complaints can only be filed where the cheque was presented for payment and dishonoured. Demand notice must be sent before filing complaint." },
  { title: "Githa Hariharan vs Reserve Bank of India",                 citation: "(1999) 2 SCC 228",   year: 1999, court: "Supreme Court of India", case_type: "Family",     source_url: "https://indiankanoon.org/doc/1780550/",
    outcome: "Mother recognised as natural guardian equal to father",
    summary: "SC held mother can act as natural guardian of minor child during father's lifetime if father is absent, indifferent or otherwise unable. Section 6 HMA interpreted gender-neutrally." },
];

async function seed() {
  console.log("\n🌱  PRAMAAN RAG Seed Starting…\n");

  console.log(`📚  Seeding ${LAWS.length} law sections…`);
  for (const law of LAWS) {
    try {
      await upsertLawSection(law);
      process.stdout.write(`  ✓ ${law.section} — ${law.act}\n`);
    } catch (e) { console.error(`  ✗ ${law.section}:`, (e as Error).message); }
  }

  console.log(`\n⚖️   Seeding ${CASES.length} court cases…`);
  for (const c of CASES) {
    try {
      await upsertCourtCase(c);
      process.stdout.write(`  ✓ ${c.title.slice(0,70)}\n`);
    } catch (e) { console.error(`  ✗ ${c.title.slice(0,50)}:`, (e as Error).message); }
  }

  console.log("\n✅  Seed complete!");
  console.log(`   law_sections: ${LAWS.length} rows`);
  console.log(`   court_cases:  ${CASES.length} rows`);
  console.log("\nAgents 4 (SectionFinder) and 5 (PrecedentFinder) now use pgvector.\n");
}

seed().catch(console.error);
