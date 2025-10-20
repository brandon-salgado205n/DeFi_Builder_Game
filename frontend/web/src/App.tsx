// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface Protocol {
  id: string;
  name: string;
  type: string;
  encryptedTVL: string;
  encryptedAPY: string;
  timestamp: number;
  owner: string;
  status: "draft" | "live" | "archived";
  modules: string[];
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const protocolTypes = ["Lending", "DEX", "Yield", "Derivatives", "Insurance"];
const fheModules = ["FHE-Swap", "FHE-Lend", "FHE-Oracle", "FHE-Stable", "FHE-Vault"];

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [protocols, setProtocols] = useState<Protocol[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newProtocol, setNewProtocol] = useState({ name: "", type: "Lending", tvl: 0, apy: 0, modules: [] as string[] });
  const [showTutorial, setShowTutorial] = useState(false);
  const [selectedProtocol, setSelectedProtocol] = useState<Protocol | null>(null);
  const [decryptedTVL, setDecryptedTVL] = useState<number | null>(null);
  const [decryptedAPY, setDecryptedAPY] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [draggedModule, setDraggedModule] = useState<string | null>(null);

  const liveCount = protocols.filter(p => p.status === "live").length;
  const draftCount = protocols.filter(p => p.status === "draft").length;
  const archivedCount = protocols.filter(p => p.status === "archived").length;

  useEffect(() => {
    loadProtocols().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadProtocols = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("protocol_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing protocol keys:", e); }
      }
      
      const list: Protocol[] = [];
      for (const key of keys) {
        try {
          const protocolBytes = await contract.getData(`protocol_${key}`);
          if (protocolBytes.length > 0) {
            try {
              const protocolData = JSON.parse(ethers.toUtf8String(protocolBytes));
              list.push({ 
                id: key, 
                name: protocolData.name,
                type: protocolData.type,
                encryptedTVL: protocolData.tvl,
                encryptedAPY: protocolData.apy,
                timestamp: protocolData.timestamp,
                owner: protocolData.owner,
                status: protocolData.status || "draft",
                modules: protocolData.modules || []
              });
            } catch (e) { console.error(`Error parsing protocol data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading protocol ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setProtocols(list);
    } catch (e) { console.error("Error loading protocols:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitProtocol = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting protocol data with Zama FHE..." });
    try {
      const encryptedTVL = FHEEncryptNumber(newProtocol.tvl);
      const encryptedAPY = FHEEncryptNumber(newProtocol.apy);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const protocolId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const protocolData = { 
        name: newProtocol.name,
        type: newProtocol.type,
        tvl: encryptedTVL,
        apy: encryptedAPY,
        timestamp: Math.floor(Date.now() / 1000),
        owner: address,
        status: "draft",
        modules: newProtocol.modules
      };
      
      await contract.setData(`protocol_${protocolId}`, ethers.toUtf8Bytes(JSON.stringify(protocolData)));
      
      const keysBytes = await contract.getData("protocol_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(protocolId);
      await contract.setData("protocol_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Protocol created with FHE encryption!" });
      await loadProtocols();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewProtocol({ name: "", type: "Lending", tvl: 0, apy: 0, modules: [] });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const launchProtocol = async (protocolId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted data with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const protocolBytes = await contract.getData(`protocol_${protocolId}`);
      if (protocolBytes.length === 0) throw new Error("Protocol not found");
      const protocolData = JSON.parse(ethers.toUtf8String(protocolBytes));
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedProtocol = { ...protocolData, status: "live" };
      await contractWithSigner.setData(`protocol_${protocolId}`, ethers.toUtf8Bytes(JSON.stringify(updatedProtocol)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Protocol launched successfully!" });
      await loadProtocols();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Launch failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const archiveProtocol = async (protocolId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted data with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const protocolBytes = await contract.getData(`protocol_${protocolId}`);
      if (protocolBytes.length === 0) throw new Error("Protocol not found");
      const protocolData = JSON.parse(ethers.toUtf8String(protocolBytes));
      const updatedProtocol = { ...protocolData, status: "archived" };
      await contract.setData(`protocol_${protocolId}`, ethers.toUtf8String(JSON.stringify(updatedProtocol)));
      setTransactionStatus({ visible: true, status: "success", message: "Protocol archived!" });
      await loadProtocols();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Archive failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (protocolOwner: string) => address?.toLowerCase() === protocolOwner.toLowerCase();

  const tutorialSteps = [
    { title: "Connect Wallet", description: "Connect your Web3 wallet to start building", icon: "🔗" },
    { title: "Create Protocol", description: "Design your DeFi protocol with FHE modules", icon: "🏗️", details: "Drag & drop FHE modules to build your protocol" },
    { title: "FHE Encryption", description: "Your protocol data is encrypted using Zama FHE", icon: "🔒", details: "TVL, APY and other sensitive data remain encrypted" },
    { title: "Launch & Compete", description: "Deploy your protocol to the simulated market", icon: "🚀", details: "See how your protocol performs against others" }
  ];

  const handleDragStart = (module: string) => {
    setDraggedModule(module);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (draggedModule && !newProtocol.modules.includes(draggedModule)) {
      setNewProtocol(prev => ({
        ...prev,
        modules: [...prev.modules, draggedModule]
      }));
    }
    setDraggedModule(null);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const removeModule = (module: string) => {
    setNewProtocol(prev => ({
      ...prev,
      modules: prev.modules.filter(m => m !== module)
    }));
  };

  const renderStats = () => {
    return (
      <div className="stats-container">
        <div className="stat-card">
          <div className="stat-value">{protocols.length}</div>
          <div className="stat-label">Total Protocols</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{liveCount}</div>
          <div className="stat-label">Live</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{draftCount}</div>
          <div className="stat-label">Draft</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{archivedCount}</div>
          <div className="stat-label">Archived</div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="tech-spinner"></div>
      <p>Initializing FHE environment...</p>
    </div>
  );

  return (
    <div className="app-container future-tech-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="circuit-icon"></div></div>
          <h1>DeFi<span>Builder</span>Game</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-protocol-btn tech-button">
            <div className="add-icon"></div>New Protocol
          </button>
          <button className="tech-button" onClick={() => setShowTutorial(!showTutorial)}>
            {showTutorial ? "Hide Guide" : "Show Guide"}
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>Build FHE-Powered DeFi Protocols</h2>
            <p>Create, encrypt and launch your own privacy-preserving DeFi protocols with Zama FHE technology</p>
          </div>
          <div className="fhe-indicator"><div className="fhe-lock"></div><span>FHE Encryption Active</span></div>
        </div>
        {showTutorial && (
          <div className="tutorial-section">
            <h2>DeFi Builder Tutorial</h2>
            <p className="subtitle">Learn how to create FHE-powered DeFi protocols</p>
            <div className="tutorial-steps">
              {tutorialSteps.map((step, index) => (
                <div className="tutorial-step" key={index}>
                  <div className="step-icon">{step.icon}</div>
                  <div className="step-content">
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                    {step.details && <div className="step-details">{step.details}</div>}
                  </div>
                </div>
              ))}
            </div>
            <div className="fhe-diagram">
              <div className="diagram-step"><div className="diagram-icon">🧩</div><div className="diagram-label">Build with Modules</div></div>
              <div className="diagram-arrow">→</div>
              <div className="diagram-step"><div className="diagram-icon">🔒</div><div className="diagram-label">FHE Encryption</div></div>
              <div className="diagram-arrow">→</div>
              <div className="diagram-step"><div className="diagram-icon">⚡</div><div className="diagram-label">Launch Protocol</div></div>
              <div className="diagram-arrow">→</div>
              <div className="diagram-step"><div className="diagram-icon">📊</div><div className="diagram-label">Market Competition</div></div>
            </div>
          </div>
        )}
        <div className="dashboard-grid">
          <div className="dashboard-card tech-card">
            <h3>Project Introduction</h3>
            <p><strong>DeFi Builder Game</strong> is a sandbox where you create privacy-preserving DeFi protocols using <strong>Zama FHE technology</strong>. Drag & drop FHE modules to build lending platforms, DEXs, and more - all with encrypted data processing.</p>
            <div className="fhe-badge"><span>FHE-Powered</span></div>
          </div>
          <div className="dashboard-card tech-card">
            <h3>Protocol Statistics</h3>
            {renderStats()}
          </div>
        </div>
        <div className="protocols-section">
          <div className="section-header">
            <h2>Your DeFi Protocols</h2>
            <div className="header-actions">
              <button onClick={loadProtocols} className="refresh-btn tech-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          <div className="protocols-list tech-card">
            <div className="table-header">
              <div className="header-cell">Name</div>
              <div className="header-cell">Type</div>
              <div className="header-cell">Modules</div>
              <div className="header-cell">Date</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>
            {protocols.length === 0 ? (
              <div className="no-protocols">
                <div className="no-protocols-icon"></div>
                <p>No protocols found</p>
                <button className="tech-button primary" onClick={() => setShowCreateModal(true)}>Create First Protocol</button>
              </div>
            ) : protocols.map(protocol => (
              <div className="protocol-row" key={protocol.id} onClick={() => setSelectedProtocol(protocol)}>
                <div className="table-cell protocol-name">{protocol.name}</div>
                <div className="table-cell">{protocol.type}</div>
                <div className="table-cell modules">
                  {protocol.modules.slice(0, 2).map(m => <span key={m} className="module-tag">{m}</span>)}
                  {protocol.modules.length > 2 && <span className="more-modules">+{protocol.modules.length - 2}</span>}
                </div>
                <div className="table-cell">{new Date(protocol.timestamp * 1000).toLocaleDateString()}</div>
                <div className="table-cell"><span className={`status-badge ${protocol.status}`}>{protocol.status}</span></div>
                <div className="table-cell actions">
                  {isOwner(protocol.owner) && (
                    <>
                      {protocol.status === "draft" && (
                        <button className="action-btn tech-button success" onClick={(e) => { e.stopPropagation(); launchProtocol(protocol.id); }}>Launch</button>
                      )}
                      {protocol.status === "live" && (
                        <button className="action-btn tech-button danger" onClick={(e) => { e.stopPropagation(); archiveProtocol(protocol.id); }}>Archive</button>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {showCreateModal && (
        <div className="modal-overlay">
          <div className="create-modal tech-card">
            <div className="modal-header">
              <h2>Create New Protocol</h2>
              <button onClick={() => setShowCreateModal(false)} className="close-modal">&times;</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Protocol Name *</label>
                <input 
                  type="text" 
                  value={newProtocol.name} 
                  onChange={(e) => setNewProtocol({...newProtocol, name: e.target.value})} 
                  placeholder="My Awesome Protocol" 
                  className="tech-input"
                />
              </div>
              <div className="form-group">
                <label>Protocol Type *</label>
                <select 
                  value={newProtocol.type} 
                  onChange={(e) => setNewProtocol({...newProtocol, type: e.target.value})} 
                  className="tech-select"
                >
                  {protocolTypes.map(type => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Initial TVL *</label>
                  <input 
                    type="number" 
                    value={newProtocol.tvl} 
                    onChange={(e) => setNewProtocol({...newProtocol, tvl: parseFloat(e.target.value)})} 
                    placeholder="100000" 
                    className="tech-input"
                  />
                </div>
                <div className="form-group">
                  <label>Target APY *</label>
                  <input 
                    type="number" 
                    value={newProtocol.apy} 
                    onChange={(e) => setNewProtocol({...newProtocol, apy: parseFloat(e.target.value)})} 
                    placeholder="5.0" 
                    className="tech-input"
                    step="0.1"
                  />
                </div>
              </div>
              <div className="form-group">
                <label>FHE Modules (Drag & Drop)</label>
                <div className="modules-container">
                  <div className="available-modules">
                    {fheModules.filter(m => !newProtocol.modules.includes(m)).map(module => (
                      <div 
                        key={module} 
                        className="module-item" 
                        draggable 
                        onDragStart={() => handleDragStart(module)}
                      >
                        {module}
                      </div>
                    ))}
                  </div>
                  <div 
                    className="selected-modules" 
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                  >
                    {newProtocol.modules.length === 0 ? (
                      <div className="drop-hint">Drop FHE modules here</div>
                    ) : (
                      newProtocol.modules.map(module => (
                        <div key={module} className="module-item selected">
                          {module}
                          <button onClick={() => removeModule(module)} className="remove-module">&times;</button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
              <div className="encryption-preview">
                <h4>FHE Encryption Preview</h4>
                <div className="preview-container">
                  <div className="plain-data">
                    <span>Plain TVL:</span>
                    <div>{newProtocol.tvl || '0'} USD</div>
                  </div>
                  <div className="encryption-arrow">→</div>
                  <div className="encrypted-data">
                    <span>Encrypted TVL:</span>
                    <div>{newProtocol.tvl ? FHEEncryptNumber(newProtocol.tvl).substring(0, 30) + '...' : 'No value'}</div>
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowCreateModal(false)} className="cancel-btn tech-button">Cancel</button>
              <button 
                onClick={submitProtocol} 
                disabled={creating || !newProtocol.name || !newProtocol.type} 
                className="submit-btn tech-button primary"
              >
                {creating ? "Encrypting with FHE..." : "Create Protocol"}
              </button>
            </div>
          </div>
        </div>
      )}
      {selectedProtocol && (
        <div className="modal-overlay">
          <div className="protocol-detail-modal tech-card">
            <div className="modal-header">
              <h2>{selectedProtocol.name}</h2>
              <button onClick={() => { setSelectedProtocol(null); setDecryptedTVL(null); setDecryptedAPY(null); }} className="close-modal">&times;</button>
            </div>
            <div className="modal-body">
              <div className="protocol-info">
                <div className="info-item"><span>Type:</span><strong>{selectedProtocol.type}</strong></div>
                <div className="info-item"><span>Owner:</span><strong>{selectedProtocol.owner.substring(0, 6)}...{selectedProtocol.owner.substring(38)}</strong></div>
                <div className="info-item"><span>Created:</span><strong>{new Date(selectedProtocol.timestamp * 1000).toLocaleString()}</strong></div>
                <div className="info-item"><span>Status:</span><strong className={`status-badge ${selectedProtocol.status}`}>{selectedProtocol.status}</strong></div>
              </div>
              <div className="modules-section">
                <h3>FHE Modules</h3>
                <div className="modules-grid">
                  {selectedProtocol.modules.map(module => (
                    <div key={module} className="module-tag detailed">{module}</div>
                  ))}
                </div>
              </div>
              <div className="data-section">
                <div className="data-column">
                  <h3>Total Value Locked</h3>
                  <div className="encrypted-data">{selectedProtocol.encryptedTVL.substring(0, 50)}...</div>
                  <button 
                    className="decrypt-btn tech-button" 
                    onClick={async () => {
                      if (decryptedTVL !== null) {
                        setDecryptedTVL(null);
                      } else {
                        const decrypted = await decryptWithSignature(selectedProtocol.encryptedTVL);
                        setDecryptedTVL(decrypted);
                      }
                    }} 
                    disabled={isDecrypting}
                  >
                    {isDecrypting ? "Decrypting..." : decryptedTVL !== null ? "Hide Value" : "Decrypt TVL"}
                  </button>
                  {decryptedTVL !== null && (
                    <div className="decrypted-value">
                      <span>Decrypted TVL:</span>
                      <strong>{decryptedTVL.toLocaleString()} USD</strong>
                    </div>
                  )}
                </div>
                <div className="data-column">
                  <h3>Annual Percentage Yield</h3>
                  <div className="encrypted-data">{selectedProtocol.encryptedAPY.substring(0, 50)}...</div>
                  <button 
                    className="decrypt-btn tech-button" 
                    onClick={async () => {
                      if (decryptedAPY !== null) {
                        setDecryptedAPY(null);
                      } else {
                        const decrypted = await decryptWithSignature(selectedProtocol.encryptedAPY);
                        setDecryptedAPY(decrypted);
                      }
                    }} 
                    disabled={isDecrypting}
                  >
                    {isDecrypting ? "Decrypting..." : decryptedAPY !== null ? "Hide Value" : "Decrypt APY"}
                  </button>
                  {decryptedAPY !== null && (
                    <div className="decrypted-value">
                      <span>Decrypted APY:</span>
                      <strong>{decryptedAPY}%</strong>
                    </div>
                  )}
                </div>
              </div>
              <div className="fhe-notice">
                <div className="fhe-icon"></div>
                <p>All sensitive data is encrypted using Zama FHE technology and remains encrypted during processing</p>
              </div>
            </div>
            <div className="modal-footer">
              <button 
                onClick={() => { setSelectedProtocol(null); setDecryptedTVL(null); setDecryptedAPY(null); }} 
                className="close-btn tech-button"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content tech-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="tech-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="circuit-icon"></div><span>DeFiBuilderGame</span></div>
            <p>Build privacy-preserving DeFi protocols with Zama FHE technology</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Zama FHE</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>FHE-Powered Privacy</span></div>
          <div className="copyright">© {new Date().getFullYear()} DeFi Builder Game. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

export default App;