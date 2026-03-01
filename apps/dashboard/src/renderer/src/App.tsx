import Chat from "./components/Chat";
import MapView from "./components/MapView";

function App(): React.JSX.Element {
  return (
    <div style={{ display: "flex", width: "100vw", height: "100vh" }}>
      <div style={{ flex: 1, height: "100%", minWidth: 0 }}>
        <MapView />
      </div>
      <div style={{ width: 360, height: "100%", flexShrink: 0 }}>
        <Chat />
      </div>
    </div>
  );
}

export default App;
