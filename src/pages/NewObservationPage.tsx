import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { NewObservationForm } from '../components/observations/NewObservationForm';

export function NewObservationPage() {
  const { isDark } = useTheme();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Pre-fill from query params (e.g. coming from ObjectDetail)
  const prefilledObjectId = searchParams.get('objectId') || '';
  const prefilledObjectName = searchParams.get('objectName') || '';

  const cardBg = isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200';

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      {/* Breadcrumb */}
      <Link
        to={prefilledObjectId ? `/object/${encodeURIComponent(prefilledObjectId)}` : '/'}
        className={`inline-flex items-center gap-2 text-sm font-medium transition ${
          isDark ? 'text-slate-400 hover:text-accent-400' : 'text-slate-500 hover:text-accent-600'
        }`}
      >
        <ArrowLeft className="w-4 h-4" />
        {prefilledObjectId ? `Back to ${prefilledObjectName || prefilledObjectId}` : 'Back to Library'}
      </Link>

      {/* Page header */}
      <div>
        <h1 className={`font-display text-3xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
          Log Observation
        </h1>
        <p className={`mt-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          Record a viewing session - optionally attach an image and notes.
        </p>
      </div>

      <div className={`rounded-2xl border p-6 ${cardBg}`}>
        <NewObservationForm
          prefilledObjectId={prefilledObjectId}
          prefilledObjectName={prefilledObjectName}
          onSuccess={result =>
            navigate(`/observations/${encodeURIComponent(result.objectId)}/${encodeURIComponent(result.date)}`)
          }
        />
      </div>
    </div>
  );
}
