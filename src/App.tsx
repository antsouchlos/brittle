import { useState } from "react";
import reactLogo from "./assets/react.svg";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import { PDFViewer } from '@embedpdf/react-pdf-viewer';

import TabbedShell from './TabbedShell';

function App() {
    return <TabbedShell />;
}

// function App() {
//     return (
//         <PDFViewer
//             style={{ width: '100%', height: '100vh' }}
//             config={{
//                 src: 'https://snippet.embedpdf.com/ebook.pdf',
//                 theme: { preference: 'dark' }
//             }}
//         />
//     );
// }

// function App() {
//   return (
//     <div style={{ height: '100vh' }}>
//       <PDFViewer 
//         config={{
//           src: 'https://snippet.embedpdf.com/ebook.pdf',
//           theme: { preference: 'dark' }
//         }}
//       />
//     </div>
//   );
// }

export default App;
