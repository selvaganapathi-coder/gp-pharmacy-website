import { useEffect, useRef, useState } from 'react'

/**
 * Counts from 0 to a numeric value once when scrolled into view.
 * Accepts values like "500+", "16", "2,350+", "41", "161", "20191".
 */
export default function CountUp({ value, className = '' }) {
  const ref = useRef(null)
  const raw = String(value ?? '').trim()
  const match = raw.match(/^([^\d]*)([\d,]+)(.*)$/)
  const prefix = match?.[1] ?? ''
  const digits = match?.[2]?.replace(/,/g, '') ?? ''
  const suffix = match?.[3] ?? (match ? '' : raw)
  const target = Number.parseInt(digits, 10)
  
  // Initialize with raw so correct value is immediately visible
  const [display, setDisplay] = useState(raw)
  const hasAnimated = useRef(false)

  // Whenever the value prop changes (e.g. from CMS updates), immediately update the displayed text
  useEffect(() => {
    setDisplay(raw)
  }, [raw])

  useEffect(() => {
    const el = ref.current
    if (!el) return undefined

    if (!Number.isFinite(target) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDisplay(raw)
      return undefined
    }

    if (hasAnimated.current) {
      setDisplay(raw)
      return undefined
    }

    const run = () => {
      if (hasAnimated.current) return
      hasAnimated.current = true
      const duration = 1200
      const start = performance.now()

      const tick = (now) => {
        const t = Math.min(1, (now - start) / duration)
        const eased = 1 - (1 - t) ** 3
        const current = Math.round(target * eased)
        setDisplay(`${prefix}${current.toLocaleString('en-IN')}${suffix}`)
        if (t < 1) requestAnimationFrame(tick)
        else setDisplay(raw)
      }

      requestAnimationFrame(tick)
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            run()
            observer.unobserve(entry.target)
          }
        })
      },
      { threshold: 0.1 }
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [raw, target, prefix, suffix])

  return (
    <strong ref={ref} className={`count-up ${className}`.trim()}>
      {display}
    </strong>
  )
}
