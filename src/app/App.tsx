import { ReactNode, useCallback, useState } from 'react';
import './App.css';
import TabView from './TabView.tsx';

const originalTabs = [
    { id: 'tab1', label: 'Tab 1', closeable: false, content: <div>Content 1</div> },
    { id: 'tab2', label: 'Tab 2', closeable: true, content: <div>Content 2</div> },
    { id: 'tab3', label: 'Tab 3', closeable: true, content: <div>Content 3</div> },
    { id: 'tab4', label: 'Tab 4', closeable: true, content: <div>Content 4</div> },
];

function App() {
    let [tabs, setTabs] = useState(originalTabs);

    return <TabView
        tabs={tabs}
        onCloseTab={(id: string) => (setTabs(prev => prev.filter(t => t.id !== id)))}
    />;
}

export default App;
