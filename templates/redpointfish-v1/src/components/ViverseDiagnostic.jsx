import React, { useEffect } from 'react';

const ViverseDiagnostic = ({ sdk, status, error }) => {
    const APP_ID = import.meta.env.VITE_VIVERSE_CLIENT_ID || 'MISSING_APP_ID';

    useEffect(() => {
        console.group('[VIVERSE Diagnostic Report]');
        console.log(`APP_ID: ${APP_ID}`);
        console.log(`SDK Status: ${status}`);
        console.log(`Iframe: ${window.self !== window.top ? 'Yes' : 'No'}`);
        console.log(`SDK Global: ${window.vSdk || window.viverse || window.VIVERSE_SDK ? 'Detected' : 'Not Found'}`);
        if (error) console.error(`Error: ${error}`);
        console.groupEnd();
    }, [sdk, status, error, APP_ID]);

    if (status !== 'failed') return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-xl p-6">
            <div className="max-w-md w-full bg-v-slate-900 border border-v-danger/30 rounded-2xl p-8 shadow-2xl">
                <h2 className="text-2xl font-bold text-v-danger mb-4 flex items-center gap-2">
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    SDK Diagnostic Report
                </h2>
                
                <div className="space-y-4 text-v-slate-400">
                    <p className="text-sm">The VIVERSE SDK failed to initialize after 30 seconds.</p>
                    
                    <div className="bg-black/50 p-4 rounded-lg font-mono text-xs space-y-2">
                        <div className="flex justify-between"><span>App ID:</span> <span className="text-white">{APP_ID}</span></div>
                        <div className="flex justify-between"><span>Status:</span> <span className="text-v-danger">{status}</span></div>
                        <div className="flex justify-between"><span>Iframe:</span> <span className="text-white">{window.self !== window.top ? 'Yes' : 'No'}</span></div>
                        <div className="flex justify-between"><span>SDK Path:</span> <span className="text-v-danger">Missing</span></div>
                    </div>

                    <ul className="list-disc list-inside space-y-1 text-sm">
                        <li>Check network connectivity</li>
                        <li>Disable ad-blockers for this domain</li>
                        <li>Ensure the script tag is correctly loaded</li>
                        <li>Verify your App ID in the dashboard</li>
                    </ul>

                    <button 
                        onClick={() => window.location.reload()}
                        className="w-full py-3 bg-v-danger hover:bg-v-danger/80 text-white font-bold rounded-xl transition-all shadow-lg shadow-v-danger/20"
                    >
                        RETRY CONNECTION
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ViverseDiagnostic;
