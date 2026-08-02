import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listEnquiries } from '../api';
import { CategoryPill, PriorityBadge } from './Badges';
import { IconSearch } from './Icons';

const DEBOUNCE_MS = 200;
const RESULT_LIMIT = 8;

export function CommandPalette({ open, onClose }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setActiveIndex(0);
      // Wait a tick for the overlay to mount before focusing.
      const focusTimeout = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(focusTimeout);
    }
    return undefined;
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      listEnquiries({ search: query, sort: 'receivedAt', order: 'desc', limit: RESULT_LIMIT }, { signal: controller.signal })
        .then((res) => {
          setResults(res.items);
          setActiveIndex(0);
        })
        .catch((e) => {
          if (e.name === 'AbortError') return; // a newer keystroke superseded this search
          setResults([]);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [query, open]);

  useEffect(() => {
    if (!open) return undefined;
    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, Math.max(0, results.length - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const chosen = results[activeIndex];
        if (chosen) goTo(chosen.id);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, results, activeIndex]);

  function goTo(id) {
    navigate(`/enquiries/${id}`);
    onClose();
  }

  if (!open) return null;

  return (
    <div className="command-palette-backdrop" onClick={onClose}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()}>
        <div className="command-palette-input-row">
          <IconSearch className="nav-icon" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search by subject, sender, PO#, facility…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="command-palette-results">
          {results.length === 0 && (
            <div className="command-palette-empty">
              {query ? 'No matching enquiries.' : 'Type to search, or browse the most recent enquiries below.'}
            </div>
          )}
          {results.map((r, i) => (
            <div
              key={r.id}
              className={`command-palette-row${i === activeIndex ? ' active' : ''}`}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => goTo(r.id)}
            >
              <div className="command-palette-row-main">
                <span className="command-palette-subject">{r.subject}</span>
                <span className="command-palette-meta">
                  {r.extractedFields.facility || r.sender.name || r.sender.email}
                </span>
              </div>
              <div className="command-palette-row-side">
                <CategoryPill category={r.category} />
                <PriorityBadge priority={r.priority} />
              </div>
            </div>
          ))}
        </div>
        <div className="command-palette-hints">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
