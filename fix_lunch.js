const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf-8');

const targetStart = "{/* Lunch Injection */}";
const targetEnd = `                     )}
                   </div>
                 ))}
               </div>`;

const startIndex = content.indexOf(targetStart);
const endIndex = content.indexOf(targetEnd, startIndex);

const replacement = `{/* Lunch Injection */}
                     {plans[activePlanIdx].lunchCandidates && plans[activePlanIdx].lunchCandidates!.length > 0 && idx === Math.floor(plans[activePlanIdx].order.length / 2) && leg.visitId && (
                        <div className="relative mt-3">
                          <div className="h-4 flex items-center justify-center absolute -top-4 left-0 right-0">
                            <div className="w-px h-full bg-slate-800" />
                          </div>
                          <motion.div 
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="bg-orange-500/10 p-4 rounded-xl border border-orange-500/30"
                          >
                             <div className="flex items-center gap-2 mb-3 text-orange-400">
                                <Utensils className="w-3.5 h-3.5" />
                                <span className="text-[10px] font-bold uppercase tracking-widest">昼食休憩の提案 (約60分) - {plans[activePlanIdx].lunchCandidates!.length}候補</span>
                             </div>
                             <div className="flex flex-col gap-2">
                               {plans[activePlanIdx].lunchCandidates!.map((candidate, i) => {
                                 const isSelected = selectedLunchCandidates[activePlanIdx] === i;
                                 const hasSelection = selectedLunchCandidates[activePlanIdx] !== undefined;

                                 return (
                                   <div 
                                     key={i} 
                                     onClick={() => setSelectedLunchCandidates(prev => ({ ...prev, [activePlanIdx]: isSelected ? undefined : i }))}
                                     className={cn(
                                       "flex justify-between items-center p-2 rounded-lg border relative cursor-pointer outline-none transition-all",
                                       isSelected 
                                         ? "bg-orange-900/40 border-orange-500 shadow-md shadow-orange-900/30 ring-2 ring-orange-500/50" 
                                         : hasSelection 
                                           ? "bg-slate-800/30 border-slate-700/50 opacity-50 grayscale hover:opacity-80" 
                                           : "bg-orange-900/20 border-orange-500/20 hover:bg-orange-900/30"
                                     )}
                                   >
                                     <div className="flex-1 min-w-0 pr-3">
                                       <h3 className="text-sm font-bold text-orange-100 flex items-center gap-2 flex-wrap">
                                         <span className="truncate">{candidate.name}</span>
                                         {candidate.hasParkingNear ? (
                                             <span className="text-[9px] bg-green-500/20 text-green-300 border border-green-500/30 px-1 py-0.5 rounded leading-none flex items-center gap-0.5 shrink-0">
                                               <span>🅿️</span> 近隣に駐車場あり
                                             </span>
                                         ) : (
                                             <span className="text-[9px] bg-slate-500/20 text-slate-300 border border-slate-500/30 px-1 py-0.5 rounded leading-none flex items-center gap-0.5 shrink-0">
                                               <span>🅿️</span> 情報なし
                                             </span>
                                         )}
                                         {candidate.rating && (
                                           <span className="text-[10px] text-yellow-500 font-bold flex items-center gap-0.5 shrink-0">
                                             ★ {candidate.rating}
                                           </span>
                                         )}
                                       </h3>
                                       <p className="text-[10px] text-orange-200/60 mt-0.5 truncate">{candidate.address}</p>
                                     </div>
                                     <button 
                                       onClick={(e) => {
                                         e.stopPropagation();
                                         window.open(\`https://www.google.com/maps/search/?api=1&query=\${encodeURIComponent(candidate.name + ' ' + candidate.address)}\`, '_blank');
                                       }}
                                       className="p-2 bg-orange-500/20 hover:bg-orange-500/30 rounded-lg transition-colors text-orange-300 shrink-0 relative z-10"
                                     >
                                       <MapPin className="w-4 h-4" />
                                     </button>
                                   </div>
                                 );
                               })}
                             </div>
                          </motion.div>
                        </div>
`;

if (startIndex > -1 && endIndex > -1) {
    const newContent = content.substring(0, startIndex) + replacement + content.substring(endIndex);
    fs.writeFileSync('src/App.tsx', newContent, 'utf-8');
    console.log("Replaced successfully!");
} else {
    console.log("Could not find bounds");
}
