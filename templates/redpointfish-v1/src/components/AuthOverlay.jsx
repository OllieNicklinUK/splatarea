import React from 'react';

const AuthOverlay = ({ profile, isAuthenticated, status, login, logout }) => {
    if (status === 'detecting' || status === 'handshaking' || status === 'checking_auth') {
        return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xl">
                <div className="flex flex-col items-center gap-6 animate-pulse">
                    <div className="w-16 h-16 border-4 border-v-accent border-t-transparent rounded-full animate-spin"></div>
                    <div className="text-xl font-bold text-v-accent tracking-widest uppercase">
                        VIVERSE {status.replace('_', ' ')}...
                    </div>
                </div>
            </div>
        );
    }

    if (!isAuthenticated) {
        return (
            <div className="fixed inset-0 z-40 flex items-center justify-center bg-v-slate-900 overflow-hidden">
                {/* Visual Flair Background */}
                <div className="absolute top-0 left-0 w-full h-full">
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-v-accent/20 blur-[120px] rounded-full"></div>
                    <div className="absolute top-1/4 left-1/4 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[400px] bg-v-success/10 blur-[100px] rounded-full"></div>
                </div>

                <div className="relative z-10 max-w-lg w-full p-12 bg-white/5 backdrop-blur-v-glass border border-white/10 rounded-[40px] shadow-2xl text-center">
                    <div className="mb-10 inline-flex items-center justify-center w-24 h-24 bg-gradient-to-tr from-v-accent to-v-accent/40 rounded-3xl rotate-12 shadow-2xl">
                        <svg className="w-12 h-12 text-white -rotate-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z" />
                        </svg>
                    </div>

                    <h1 className="text-5xl font-black mb-4 tracking-tighter bg-clip-text text-transparent bg-gradient-to-r from-white to-white/40">
                        Red Point Fish
                    </h1>
                    <p className="text-v-slate-400 text-lg mb-10 leading-relaxed px-4">
                        A premium 1v1 multiplayer poker experience. Sign in with VIVERSE to begin your journey.
                    </p>

                    <button 
                        onClick={login}
                        className="group relative w-full py-5 bg-v-accent hover:bg-v-accent/80 text-white font-bold rounded-2xl transition-all duration-300 shadow-[0_20px_50px_rgba(110,99,235,0.3)] active:scale-[0.98]"
                    >
                        <span className="relative z-10 flex items-center justify-center gap-2">
                            CONNECT WITH VIVERSE
                            <svg className="w-5 h-5 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                            </svg>
                        </span>
                    </button>
                    
                    <p className="mt-8 text-xs text-v-slate-500 font-medium uppercase tracking-widest">
                        Handshake: {status}
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="fixed top-6 right-6 z-40 flex items-center gap-4 p-2 pl-6 pr-3 bg-white/5 backdrop-blur-v-glass border border-white/10 rounded-full shadow-2xl animate-fade-in group">
            <div className="flex flex-col items-end">
                <span className="text-sm font-bold text-white leading-tight">{profile?.displayName}</span>
                <span className="text-[10px] text-v-success font-black uppercase tracking-widest leading-tight">ONLINE</span>
            </div>
            
            <div className="relative">
                {profile?.avatarUrl ? (
                    <img 
                        src={profile.avatarUrl} 
                        alt="Avatar" 
                        className="w-10 h-10 rounded-full border-2 border-v-accent object-cover bg-v-slate-900" 
                    />
                ) : (
                    <div className="w-10 h-10 rounded-full border-2 border-v-accent bg-v-accent/20 flex items-center justify-center">
                        <svg className="w-5 h-5 text-v-accent" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08s5.97 1.09 6 3.08c-1.29 1.94-3.5 3.22-6 3.22z" />
                        </svg>
                    </div>
                )}
            </div>

            <button 
                onClick={logout}
                className="w-10 h-10 rounded-full bg-v-danger/20 hover:bg-v-danger/40 flex items-center justify-center transition-all opacity-0 group-hover:opacity-100 -ml-14 group-hover:ml-0 translate-x-4 group-hover:translate-x-0"
            >
                <svg className="w-5 h-5 text-v-danger" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
            </button>
        </div>
    );
};

export default AuthOverlay;
