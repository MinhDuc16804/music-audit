# Prompt & PRD: Music Copyright Checker AI Agent Assistant

## 🎯 Objective
Create a standalone Web Application (React + Tailwind CSS) named **Music Copyright Checker AI Agent Assistant**. 
This tool acts as a specialized assistant helping content creators, marketers, and video editors analyze, verify, and determine the commercial copyright status of music tracks based on song titles and artist names.

---

## 🛠 Tech Stack Requirements
- **Framework:** React (Single-file Component structure).
- **Styling:** Tailwind CSS (Modern dark mode design system).
- **Icons:** `lucide-react`.

---

## 💡 Key Features & Logic

### 1. Music Copyright Analysis Engine (Mock/Rule-Based Heuristics)
The application should classify input into 3 primary status categories:
- 🟢 **SAFE (Public Domain):** Free for commercial use (e.g., classical music where composer died > 70 years ago). Warning about Master Recording rights vs Composition rights.
- 🟡 **WARNING (Creative Commons / Royalty-Free with Attribution):** Commercial use allowed provided proper credit/attribution is pasted in the description.
- 🔴 **RESTRICTED (Major Commercial Record Labels):** Strict copyright (Universal, Sony, Warner, etc.). Requires explicit Sync Licensing for commercial/paid ads use.

### 2. Input Form & Parameters
- Input field: **Song Title** (Tên bài hát).
- Input field: **Artist / Composer Name** (Tác giả / Nghệ sĩ).
- Dropdown selector: **Use Case / Purpose** (YouTube Monetized, Paid Ads / TikTok Ads, Corporate Film, Podcast / Livestream).
- Quick Test Preset Buttons: (e.g., "Fur Elise - Beethoven", "Faded - Alan Walker", "Shape of You - Ed Sheeran").

### 3. Comprehensive Analysis Output
When analyzed, display:
- **Status Badge:** Visual indicator (Safe, Conditional, High Risk).
- **Detailed License Info:** Explaining Composition vs Master Recording rights.
- **Attribution Copy Helper:** A 1-click button to copy structured text for YouTube/TikTok descriptions if attribution is required.
- **Actionable Steps:** Step-by-step advice for the user based on their selected use-case.
- **Alternative Safe Sources:** Recommendations like YouTube Audio Library, Pixabay, Epidemic Sound, etc.

### 4. Extra Tabs / Sections
- **Checklist & Legal Guide Tab:** Explaining key legal concepts (Sync License, Commercial vs Non-Commercial, Storing Invoices).
- **Safe Music Library Directory Tab:** Categorized list of free & paid safe music resources.

---

## 🎨 UI & UX Design Requirements
- **Theme:** Modern Dark Theme (`bg-slate-950`, `bg-slate-900`, indigo/violet accents).
- **Language:** Vietnamese interface (Tiếng Việt).
- **Responsive Layout:** Grid-based layout optimized for desktop and mobile screens.

---

## 📝 Single-File React Code Template

Below is the complete React code for reference to build or run directly:

```jsx
import React, { useState } from 'react';
import { 
  ShieldCheck, ShieldAlert, ShieldX, Search, Music, User, Info, 
  CheckCircle2, BookOpen, Layers, Copy, Check, ExternalLink, RefreshCw, Scale, Sparkles 
} from 'lucide-react';

const MOCK_DATABASE = [
  {
    keywords: ["beethoven", "mozart", "bach", "chopin", "fur elise", "moonlight sonata"],
    title: "Tác phẩm Nhạc cổ điển",
    artist: "Tác giả cổ điển (Đã mất > 70 năm)",
    status: "SAFE",
    licenseType: "Public Domain (Tài sản công cộng)",
    commercialAllowed: true,
    attributionRequired: false,
    details: "Bản phổ (Composition) thuộc Tài sản công cộng. Tuy nhiên bản thu âm (Master Recording) do dàn nhạc hiện đại biểu diễn có thể vẫn có bản quyền riêng.",
    actions: ["Có thể tự thu âm lại bản phổ.", "Nếu dùng bản thu sẵn, kiểm tra quyền Master."],
    riskLevel: "Thấp",
    suggestedAlternatives: ["Musopen.org", "IMSLP Library"]
  },
  {
    keywords: ["faded", "alan walker", "ncs", "nocopyrightsounds"],
    title: "Nhạc NoCopyrightSounds / Creative Commons",
    artist: "Alan Walker / NCS Creators",
    status: "WARNING",
    licenseType: "Creative Commons (CC BY 4.0)",
    commercialAllowed: true,
    attributionRequired: true,
    details: "Cho phép dùng thương mại trên mạng xã hội với điều kiện BẮT BUỘC ghi nguồn đúng mẫu.",
    actions: ["Sao chép đoạn Ghi nguồn vào phần mô tả video."],
    riskLevel: "Trung bình",
    suggestedAlternatives: ["NCS.io Library", "YouTube Audio Library"]
  },
  {
    keywords: ["shape of you", "ed sheeran", "taylor swift", "son tung"],
    title: "Bản thu Pop Commercial Pop HIT",
    artist: "Ca sĩ / Major Record Label",
    status: "RESTRICTED",
    licenseType: "Strict Commercial Copyright",
    commercialAllowed: false,
    attributionRequired: false,
    details: "Tác phẩm thuộc sở hữu bản quyền nghiêm ngặt. Tự ý chèn vào video thương mại/quảng cáo dễ bị kiện hoặc đánh gậy bản quyền.",
    actions: ["Tuyệt đối không dùng cho Paid Ads.", "Xin giấy phép Sync License nếu muốn sử dụng."],
    riskLevel: "Rất Cao",
    suggestedAlternatives: ["Epidemic Sound", "Artlist.io"]
  }
];

export default function App() {
  const [songTitle, setSongTitle] = useState('');
  const [artistName, setArtistName] = useState('');
  const [useCase, setUseCase] = useState('youtube_monetized');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState(null);
  const [copiedText, setCopiedText] = useState(false);
  const [activeTab, setActiveTab] = useState('checker');

  const handleAnalyze = (e) => {
    e?.preventDefault();
    if (!songTitle.trim() && !artistName.trim()) return;

    setIsAnalyzing(true);
    setResult(null);

    setTimeout(() => {
      const query = `${songTitle} ${artistName}`.toLowerCase();
      let match = MOCK_DATABASE.find(item => item.keywords.some(kw => query.includes(kw)));

      if (!match) {
        match = {
          title: songTitle || "Tác phẩm Âm nhạc",
          artist: artistName || "Nghệ sĩ",
          status: "RESTRICTED",
          licenseType: "Commercial Copyright (Giả định khép kín)",
          commercialAllowed: false,
          attributionRequired: false,
          details: "Mặc định tác phẩm phát hành thương mại đều bảo hộ bản quyền toàn phần. Cần cẩn trọng khi đưa vào sản phẩm bán hàng.",
          actions: ["Kiểm tra kỹ hợp đồng mua bản quyền.", "Không tự ý ghép vào video quảng cáo."],
          riskLevel: "Cao",
          suggestedAlternatives: ["Epidemic Sound", "Artlist", "YouTube Audio Library"]
        };
      }

      setResult({ ...match, inputTitle: songTitle || match.title, inputArtist: artistName || match.artist });
      setIsAnalyzing(false);
    }, 1000);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 font-sans">
      <header className="max-w-5xl mx-auto flex justify-between items-center pb-6 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <Scale className="w-7 h-7 text-indigo-500" />
          <h1 className="text-xl font-bold">Music Copyright AI Agent</h1>
        </div>
      </header>

      <main className="max-w-5xl mx-auto mt-8">
        <form onSubmit={handleAnalyze} className="bg-slate-900 p-6 rounded-2xl border border-slate-800 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <input 
              type="text" 
              placeholder="Tên bài hát..." 
              value={songTitle} 
              onChange={e => setSongTitle(e.target.value)}
              className="bg-slate-950 border border-slate-700 p-3 rounded-xl text-sm"
              required
            />
            <input 
              type="text" 
              placeholder="Tên ca sĩ / tác giả..." 
              value={artistName} 
              onChange={e => setArtistName(e.target.value)}
              className="bg-slate-950 border border-slate-700 p-3 rounded-xl text-sm"
            />
          </div>
          <button type="submit" className="w-full bg-indigo-600 hover:bg-indigo-500 py-3 rounded-xl font-medium text-sm transition">
            {isAnalyzing ? "Đang phân tích..." : "Phân tích Bản quyền"}
          </button>
        </form>

        {result && (
          <div className="mt-6 bg-slate-900 p-6 rounded-2xl border border-slate-800">
            <h3 className="text-lg font-bold text-indigo-400">{result.inputTitle} - {result.inputArtist}</h3>
            <p className="text-sm mt-2 text-slate-300">{result.details}</p>
            <div className="mt-4 text-xs font-semibold uppercase px-3 py-1 inline-block rounded border" style={{
              color: result.status === 'SAFE' ? '#10b981' : result.status === 'WARNING' ? '#f59e0b' : '#f43f5e'
            }}>
              Trạng thái: {result.licenseType}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
```