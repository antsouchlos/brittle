import { useState } from 'react';
import './App.css';
import TabView from '../tabs/TabView.tsx';
import LibraryTabContent from './LibraryTabContent.tsx';


const originalTabs = [
    { id: 'tab1', label: 'Library', closeable: false, content: <LibraryTabContent /> },
    { id: 'tab2', label: 'A.pdf', closeable: true, content: <div>Content 2</div> },
    { id: 'tab3', label: 'B.pdf', closeable: true, content: <div>Content 3</div> },
    { id: 'tab4', label: 'C.pdf', closeable: true, content: <div>Content 4</div> },
];

function App() {
    let [tabs, setTabs] = useState(originalTabs);

    return <TabView
        tabs={tabs}
        onCloseTab={(id: string) => (setTabs(prev => prev.filter(t => t.id !== id)))}
        onReorderTabs={(from: number, to: number) => setTabs(prev => {
            const next = prev.slice();
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved);
            return next;
        })}
    />;
}

export default App;
