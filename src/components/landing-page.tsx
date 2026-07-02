"use client";

import Image from "next/image";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Expand,
  Pause,
  Play,
  Shirt,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

const decisionSteps = [
  {
    number: "01",
    title: "管理云端衣橱",
    kicker: "让已经拥有的，先参与判断",
    description:
      "整理衣服、标签和使用场景，让品类、穿着频率与真实生活成为下一次购买前的依据。",
    image: "/landing/closet.png",
    imageAlt: "买对衣云端衣橱管理界面",
  },
  {
    number: "02",
    title: "待买衣服咨询",
    kicker: "把一时喜欢，放回真实生活",
    description:
      "上传待买商品，由 AI 结合现有衣橱、价格与使用场景继续追问、比较并给出建议。",
    image: "/landing/chat.png",
    imageAlt: "买对衣待买衣服决策咨询界面",
  },
  {
    number: "03",
    title: "时间给出答案",
    kicker: "买、收藏或放下都成立",
    description:
      "把使用频率、维护成本与重复购买风险放在一起，留下能进入长期生活的选择，也允许今天不买。",
    image: "/landing/decision-list.png",
    imageAlt: "买对衣可复盘决策清单",
  },
] as const;

const philosophyPrinciples = [
  {
    number: "01",
    title: "先看已有",
    description: "让真实衣橱参与判断，再决定是否需要新增。",
  },
  {
    number: "02",
    title: "再看场景",
    description: "让生活需要定义价值，而不是让一时冲动替你回答。",
  },
  {
    number: "03",
    title: "留给时间",
    description: "允许收藏、复盘与放下，让冷静后的自己完成选择。",
  },
] as const;

type OutfitSlide = {
  id: string;
  image: string;
  imageAlt: string;
  scene: string;
  title: string;
  description: string;
};

const outfitSlides: OutfitSlide[] = [
  {
    id: "workday",
    image: "/landing/outfit-reuse-01.webp",
    imageAlt: "男模身穿深海军蓝上衣与深灰色剪裁西裤",
    scene: "01 / WORKDAY",
    title: "工作日的分寸",
    description: "让利落留在剪裁里，不必留在用力里。",
  },
  {
    id: "city",
    image: "/landing/outfit-reuse-02.webp",
    imageAlt: "男模身穿深海军蓝上衣与深色阔腿牛仔裤",
    scene: "02 / CITY",
    title: "城市里的锋芒",
    description:
      "换一种有重量的轮廓，熟悉的上衣也能长出新的性格。",
  },
  {
    id: "weekend",
    image: "/landing/outfit-reuse-03.webp",
    imageAlt: "男模身穿深海军蓝上衣、水洗牛仔裤与白色运动鞋",
    scene: "03 / WEEKEND",
    title: "周末的步调",
    description: "轮廓松一点，日常就有了呼吸。",
  },
  {
    id: "off-duty",
    image: "/landing/outfit-reuse-04.webp",
    imageAlt: "男模身穿深海军蓝上衣、灰色运动裤与运动鞋",
    scene: "04 / OFF-DUTY",
    title: "慢下来的时刻",
    description:
      "真正值得留下的衣服，也应该陪你走进最放松的生活。",
  },
];

const faqs = [
  {
    question: "买对衣如何判断一件衣服是否值得购买？",
    answer:
      "它会结合商品信息、你的真实衣橱、常见场景、个人偏好与长期使用成本进行判断，并把依据整理成可追溯的决策报告。",
  },
  {
    question: "如果我现在不想买，会怎样？",
    answer:
      "你可以先收藏，保留当时的证据和犹豫点，之后再回来复盘。对买对衣来说，暂时不决定也是完整的结果。",
  },
  {
    question: "需要先上传很多衣服吗？",
    answer:
      "不需要一次完成。可以先从最常穿的几件开始，随着衣橱逐步完整，系统对重复购买和真实搭配的判断也会更准确。",
  },
  {
    question: "AI 会替我做决定吗？",
    answer:
      "不会。AI 负责整理证据、指出风险并给出建议，最终选择始终属于你。页面中的 AI 内容也会明确标注仅供参考。",
  },
] as const;

type Preview = {
  src: string;
  alt: string;
} | null;

function Brand() {
  return (
    <Link className="landing-brand" href="/" aria-label="买对衣首页">
      <span className="landing-brand-mark">
        <Shirt aria-hidden="true" />
      </span>
      <span>
        <strong>买对衣</strong>
        <small>认真选择，长久相处</small>
      </span>
    </Link>
  );
}

export function LandingPage() {
  const [isScrolled, setIsScrolled] = useState(false);
  const [isStoryImmersive, setIsStoryImmersive] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const [activeOutfit, setActiveOutfit] = useState(0);
  const [isOutfitPaused, setIsOutfitPaused] = useState(false);
  const [isOutfitHovered, setIsOutfitHovered] = useState(false);
  const [isOutfitFocusWithin, setIsOutfitFocusWithin] = useState(false);
  const [isOutfitInView, setIsOutfitInView] = useState(false);
  const [isPageVisible, setIsPageVisible] = useState(true);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [outfitAnnouncement, setOutfitAnnouncement] = useState("");
  const [preview, setPreview] = useState<Preview>(null);
  const storyRef = useRef<HTMLElement>(null);
  const storyHeroRef = useRef<HTMLDivElement>(null);
  const storyFramesRef = useRef<HTMLDivElement>(null);
  const storyCardRef = useRef<HTMLDivElement>(null);
  const storyMasterRef = useRef<HTMLDivElement>(null);
  const storyPersonRef = useRef<HTMLDivElement>(null);
  const storyShadeRef = useRef<HTMLDivElement>(null);
  const storyConceptRef = useRef<HTMLDivElement>(null);
  const theaterRef = useRef<HTMLElement>(null);
  const outfitVisualRef = useRef<HTMLDivElement>(null);
  const outfitTouchStartRef = useRef<number | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let animationFrame = 0;
    let targetProgress = 0;
    let currentProgress = 0;
    let lastFrameTime = 0;
    let lastScrolled = false;
    let lastImmersive = false;
    let lastStep = 0;
    const motionPreference = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );

    const clamp = (value: number) => Math.min(1, Math.max(0, value));
    const smoothStep = (start: number, end: number, value: number) => {
      const normalized = clamp((value - start) / (end - start));
      return normalized * normalized * (3 - 2 * normalized);
    };

    const renderStory = (progress: number) => {
      const heroExit = smoothStep(0.1, 0.48, progress);
      const backgroundGrowth = smoothStep(0.06, 0.72, progress);
      const personGrowth = smoothStep(0.02, 0.66, progress);
      const masterEnter = smoothStep(0.58, 0.8, progress);
      const conceptEnter = smoothStep(0.72, 0.94, progress);
      const frameExit = smoothStep(0.18, 0.54, progress);

      const cardTransform = `translate3d(${(
        (1 - backgroundGrowth) *
        26
      ).toFixed(3)}vw, ${((1 - backgroundGrowth) * 9).toFixed(
        3,
      )}vh, 0) scale(${(0.46 + backgroundGrowth * 0.54).toFixed(5)})`;
      const personTransform = `translate3d(${(
        (1 - personGrowth) *
        12
      ).toFixed(3)}vw, ${((1 - personGrowth) * -8).toFixed(
        3,
      )}vh, 0) scale(${(0.72 + personGrowth * 0.28).toFixed(5)})`;

      if (storyCardRef.current) {
        storyCardRef.current.style.transform = cardTransform;
        storyCardRef.current.style.opacity = (1 - masterEnter).toFixed(4);
      }
      if (storyFramesRef.current) {
        storyFramesRef.current.style.transform = cardTransform;
        storyFramesRef.current.style.opacity = (1 - frameExit).toFixed(4);
      }
      if (storyPersonRef.current) {
        storyPersonRef.current.style.transform = personTransform;
        storyPersonRef.current.style.opacity = (1 - masterEnter).toFixed(4);
      }
      if (storyMasterRef.current) {
        storyMasterRef.current.style.transform = `translate3d(0, 0, 0) scale(${(
          1.035 -
          masterEnter * 0.035
        ).toFixed(5)})`;
        storyMasterRef.current.style.opacity = masterEnter.toFixed(4);
      }
      if (storyHeroRef.current) {
        storyHeroRef.current.style.opacity = (1 - heroExit).toFixed(4);
        storyHeroRef.current.style.transform = `translate3d(0, ${(
          heroExit * -72
        ).toFixed(2)}px, 0)`;
      }
      if (storyShadeRef.current) {
        storyShadeRef.current.style.opacity = conceptEnter.toFixed(4);
      }
      if (storyConceptRef.current) {
        storyConceptRef.current.style.opacity = conceptEnter.toFixed(4);
        storyConceptRef.current.style.transform = `translate3d(0, ${(
          (1 - conceptEnter) *
          42
        ).toFixed(2)}px, 0)`;
      }

    };

    const resetStoryStyles = () => {
      [
        storyHeroRef,
        storyFramesRef,
        storyCardRef,
        storyMasterRef,
        storyPersonRef,
        storyShadeRef,
        storyConceptRef,
      ].forEach((ref) => {
        ref.current?.style.removeProperty("transform");
        ref.current?.style.removeProperty("opacity");
      });
    };

    const tick = (time: number) => {
      const delta = lastFrameTime
        ? Math.min((time - lastFrameTime) / 1000, 0.05)
        : 1 / 60;
      lastFrameTime = time;
      const interpolation = 1 - Math.exp(-delta / 0.105);
      currentProgress += (targetProgress - currentProgress) * interpolation;

      renderStory(currentProgress);

      if (Math.abs(targetProgress - currentProgress) > 0.0004) {
        animationFrame = window.requestAnimationFrame(tick);
      } else {
        currentProgress = targetProgress;
        renderStory(currentProgress);
        animationFrame = 0;
        lastFrameTime = 0;
      }
    };

    const startAnimation = () => {
      if (!animationFrame) {
        lastFrameTime = 0;
        animationFrame = window.requestAnimationFrame(tick);
      }
    };

    const measure = () => {
      const scrolled = window.scrollY > 24;
      if (scrolled !== lastScrolled) {
        lastScrolled = scrolled;
        setIsScrolled(scrolled);
      }

      const story = storyRef.current;
      const isStatic = window.innerWidth <= 900 || motionPreference.matches;
      if (story && !isStatic) {
        const rect = story.getBoundingClientRect();
        const distance = Math.max(1, rect.height - window.innerHeight);
        targetProgress = clamp(-rect.top / distance);
        const immersive =
          targetProgress >= 0.7 && rect.bottom > window.innerHeight * 0.92;
        if (immersive !== lastImmersive) {
          lastImmersive = immersive;
          setIsStoryImmersive(immersive);
        }
        startAnimation();
      } else {
        if (animationFrame) {
          window.cancelAnimationFrame(animationFrame);
          animationFrame = 0;
          lastFrameTime = 0;
        }
        targetProgress = 0;
        currentProgress = 0;
        resetStoryStyles();
        if (lastImmersive) {
          lastImmersive = false;
          setIsStoryImmersive(false);
        }
      }

      const theater = theaterRef.current;
      if (theater) {
        const rect = theater.getBoundingClientRect();
        const distance = Math.max(1, rect.height - window.innerHeight);
        const progress = clamp(-rect.top / distance);
        const nextStep = Math.min(
          decisionSteps.length - 1,
          Math.floor(progress * decisionSteps.length),
        );
        if (nextStep !== lastStep) {
          lastStep = nextStep;
          setActiveStep(nextStep);
        }
      }
    };

    measure();
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    motionPreference.addEventListener("change", measure);

    return () => {
      window.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      motionPreference.removeEventListener("change", measure);
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  useEffect(() => {
    if (!preview) return;

    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreview(null);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
    };
  }, [preview]);

  useEffect(() => {
    const motionPreference = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );
    const updateMotionPreference = () =>
      setPrefersReducedMotion(motionPreference.matches);
    const updatePageVisibility = () =>
      setIsPageVisible(document.visibilityState === "visible");

    updateMotionPreference();
    updatePageVisibility();

    const outfitVisual = outfitVisualRef.current;
    const observer =
      outfitVisual && "IntersectionObserver" in window
        ? new IntersectionObserver(
            ([entry]) => setIsOutfitInView(entry.intersectionRatio >= 0.5),
            { threshold: [0, 0.5, 1] },
          )
        : null;

    if (observer && outfitVisual) observer.observe(outfitVisual);
    else setIsOutfitInView(true);

    motionPreference.addEventListener("change", updateMotionPreference);
    document.addEventListener("visibilitychange", updatePageVisibility);

    return () => {
      observer?.disconnect();
      motionPreference.removeEventListener("change", updateMotionPreference);
      document.removeEventListener("visibilitychange", updatePageVisibility);
    };
  }, []);

  useEffect(() => {
    if (
      isOutfitPaused ||
      isOutfitHovered ||
      isOutfitFocusWithin ||
      !isOutfitInView ||
      !isPageVisible ||
      prefersReducedMotion
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      setActiveOutfit((current) => (current + 1) % outfitSlides.length);
    }, 1500);

    return () => window.clearTimeout(timer);
  }, [
    activeOutfit,
    isOutfitFocusWithin,
    isOutfitHovered,
    isOutfitInView,
    isOutfitPaused,
    isPageVisible,
    prefersReducedMotion,
  ]);

  function selectOutfit(index: number) {
    const nextIndex =
      (index + outfitSlides.length) % outfitSlides.length;
    const slide = outfitSlides[nextIndex];
    setActiveOutfit(nextIndex);
    setOutfitAnnouncement(`${slide.scene}，${slide.title}`);
  }

  function showPreviousOutfit() {
    selectOutfit(activeOutfit - 1);
  }

  function showNextOutfit() {
    selectOutfit(activeOutfit + 1);
  }

  function handleOutfitTouchStart(event: React.TouchEvent<HTMLElement>) {
    outfitTouchStartRef.current = event.touches[0]?.clientX ?? null;
  }

  function handleOutfitTouchEnd(event: React.TouchEvent<HTMLElement>) {
    const start = outfitTouchStartRef.current;
    const end = event.changedTouches[0]?.clientX;
    outfitTouchStartRef.current = null;
    if (start === null || end === undefined) return;

    const distance = end - start;
    if (Math.abs(distance) < 40) return;
    if (distance > 0) showPreviousOutfit();
    else showNextOutfit();
  }

  function jumpToStep(index: number) {
    const theater = theaterRef.current;
    if (!theater) return;

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const start = theater.getBoundingClientRect().top + window.scrollY;
    const distance = Math.max(0, theater.offsetHeight - window.innerHeight);
    const target = start + (distance * (index + 0.25)) / decisionSteps.length;

    window.scrollTo({
      top: target,
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }

  function jumpToPhilosophy(event: React.MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();

    const story = storyRef.current;
    if (!story) return;

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    if (window.innerWidth <= 900 || reduceMotion) {
      document.getElementById("manifesto")?.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "start",
      });
      return;
    }

    const start = story.getBoundingClientRect().top + window.scrollY;
    const distance = Math.max(0, story.offsetHeight - window.innerHeight);

    window.scrollTo({
      top: start + distance * 0.82,
      behavior: "smooth",
    });
  }

  return (
    <main className="longterm-landing">
      <header
        className={`landing-nav${isScrolled ? " is-scrolled" : ""}${
          isStoryImmersive ? " is-immersive" : ""
        }`}
      >
        <div className="landing-nav-inner">
          <Brand />
          <nav className="landing-nav-links" aria-label="首页导航">
            <a href="#journey">一次选择</a>
            <a href="#manifesto" onClick={jumpToPhilosophy}>
              长期主义
            </a>
            <a href="#outfits">一衣多穿</a>
            <a href="#faq">常见问题</a>
          </nav>
          <Link className="landing-button landing-button-small" href="/app">
            开始一条长期决策
            <ArrowRight aria-hidden="true" />
          </Link>
        </div>
      </header>

      <section
        className="landing-story"
        ref={storyRef}
        aria-label="从长期选择到长期主义"
      >
        <div className="landing-story-sticky">
          <div
            className="landing-story-hero"
            ref={storyHeroRef}
            aria-labelledby="landing-title"
          >
            <div className="landing-shell landing-story-hero-content">
              <p className="landing-eyebrow landing-hero-reveal">
                <Sparkles aria-hidden="true" />
                LONG-TERM WARDROBE · 长期衣橱
              </p>
              <h1
                id="landing-title"
                className="landing-display landing-story-title"
              >
                <span>让每一次选择，</span>
                <span>都经得起时间。</span>
              </h1>
              <p className="landing-story-copy landing-hero-reveal">
                不是克制喜欢，而是把喜欢留给真正会进入生活的衣服。
              </p>
              <div className="landing-story-actions landing-hero-reveal">
                <Link className="landing-button" href="/app">
                  开始一条长期决策
                  <ArrowRight aria-hidden="true" />
                </Link>
                <a
                  className="landing-text-link"
                  href="#manifesto"
                  onClick={jumpToPhilosophy}
                >
                  理解我们的选择观
                  <ChevronRight aria-hidden="true" />
                </a>
              </div>
            </div>
          </div>

          <div
            className="landing-story-frames"
            ref={storyFramesRef}
            aria-hidden="true"
          >
            <span />
            <span />
            <span />
          </div>

          <div className="landing-story-card" ref={storyCardRef}>
            <Image
              className="landing-story-background-image"
              src="/landing/longterm-background.jpg"
              alt=""
              fill
              priority
              sizes="100vw"
            />
          </div>

          <div className="landing-story-master" ref={storyMasterRef}>
            <Image
              className="landing-story-master-image"
              src="/landing/longterm-master.jpg"
              alt="一位身着深海军蓝上衣与米白长裤的模特站在暖色建筑空间中"
              fill
              priority
              sizes="100vw"
            />
          </div>

          <div
            className="landing-story-person"
            ref={storyPersonRef}
            aria-hidden="true"
          >
            <Image
              src="/landing/longterm-person-v2.webp"
              alt=""
              width={337}
              height={1214}
              priority
              sizes="(max-width: 900px) 1px, 32vw"
            />
          </div>

          <div
            className="landing-story-shade"
            ref={storyShadeRef}
            aria-hidden="true"
          />

          <div
            className="landing-story-concept"
            ref={storyConceptRef}
            id="manifesto"
            aria-labelledby="manifesto-title"
          >
            <Image
              className="landing-story-concept-image"
              src="/landing/longterm-master.jpg"
              alt=""
              fill
              sizes="(max-width: 900px) 100vw, 1px"
            />
            <div className="landing-shell landing-story-concept-inner">
              <p className="landing-story-concept-label">
                LONG-TERMISM · 长期主义
              </p>
              <h2
                id="manifesto-title"
                className="landing-display landing-story-concept-title"
              >
                不是少买，
                <br />
                而是让每一次购买
                <br />
                都值得被长期使用。
              </h2>
              <p className="landing-story-concept-copy">
                买得少不是目标；减少后悔和重复购买，让真正适合的衣服进入生活，才是目标。
              </p>
              <div className="landing-story-principles">
                {philosophyPrinciples.map((item) => (
                  <article key={item.number}>
                    <span>{item.number}</span>
                    <h3>{item.title}</h3>
                    <p>{item.description}</p>
                  </article>
                ))}
              </div>
            </div>
          </div>

        </div>
      </section>

      <section
        className="decision-theater"
        id="journey"
        ref={theaterRef}
        aria-labelledby="journey-title"
      >
        <div className="decision-theater-sticky">
          <div className="landing-shell decision-theater-grid">
            <div className="decision-theater-copy">
              <p className="landing-section-label">决策剧场</p>
              <h2 id="journey-title" className="landing-display">
                一次选择的
                <br />
                真实旅程
              </h2>
              <p className="decision-theater-intro">
                好的判断，不会催你下单。它会把商品重新放回你的衣橱、场景与时间里。
              </p>

              <div className="decision-step-list">
                {decisionSteps.map((step, index) => (
                  <button
                    className={`decision-step${activeStep === index ? " is-active" : ""}`}
                    key={step.number}
                    type="button"
                    onClick={() => jumpToStep(index)}
                    aria-pressed={activeStep === index}
                  >
                    <span className="decision-step-number">{step.number}</span>
                    <span>
                      <strong>{step.title}</strong>
                      <small>{step.kicker}</small>
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="decision-stage">
              <div className="decision-stage-topline">
                <span>
                  {decisionSteps[activeStep].number} / 0{decisionSteps.length}
                </span>
                <span>{decisionSteps[activeStep].kicker}</span>
              </div>
              <button
                className="decision-stage-preview"
                type="button"
                onClick={() =>
                  setPreview({
                    src: decisionSteps[activeStep].image,
                    alt: decisionSteps[activeStep].imageAlt,
                  })
                }
                aria-label={`放大查看${decisionSteps[activeStep].title}`}
              >
                <div className="decision-stage-media">
                  {decisionSteps.map((step, index) => (
                    <Image
                      className={activeStep === index ? "is-active" : ""}
                      key={step.number}
                      src={step.image}
                      alt={step.imageAlt}
                      fill
                      sizes="(max-width: 960px) 92vw, 680px"
                    />
                  ))}
                </div>
                <span className="decision-stage-expand">
                  <Expand aria-hidden="true" />
                  查看完整界面
                </span>
              </button>
              <div className="decision-stage-caption" aria-live="polite">
                <strong>{decisionSteps[activeStep].title}</strong>
                <p>{decisionSteps[activeStep].description}</p>
              </div>
              <div className="decision-progress" aria-hidden="true">
                {decisionSteps.map((step, index) => (
                  <span
                    className={activeStep >= index ? "is-active" : ""}
                    key={step.number}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section
        className="landing-outfits"
        id="outfits"
        role="region"
        aria-labelledby="outfits-title"
        aria-roledescription="轮播"
        onMouseEnter={() => setIsOutfitHovered(true)}
        onMouseLeave={() => setIsOutfitHovered(false)}
        onFocusCapture={() => setIsOutfitFocusWithin(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setIsOutfitFocusWithin(false);
          }
        }}
        onTouchStart={handleOutfitTouchStart}
        onTouchEnd={handleOutfitTouchEnd}
      >
        <div className="landing-shell landing-outfits-layout">
          <div className="landing-outfits-visual" ref={outfitVisualRef}>
            {outfitSlides.map((slide, index) => (
              <Image
                className={activeOutfit === index ? "is-active" : ""}
                key={slide.id}
                src={slide.image}
                alt={activeOutfit === index ? slide.imageAlt : ""}
                aria-hidden={activeOutfit !== index}
                fill
                sizes="(max-width: 900px) 100vw, 58vw"
              />
            ))}
            <span className="landing-outfits-count" aria-hidden="true">
              0{activeOutfit + 1} / 0{outfitSlides.length}
            </span>
          </div>

          <div className="landing-outfits-copy">
            <p className="landing-outfits-label">
              ONE PIECE, MANY LIVES · 一衣多穿
            </p>
            <h2 id="outfits-title" className="landing-display">
              一件真正适合你的
              <br className="landing-outfits-title-break-mobile" />
              衣服，
              <br className="landing-outfits-title-break-desktop" />
              会在不同的
              <br className="landing-outfits-title-break-mobile" />
              生活里，
              <br className="landing-outfits-title-break-desktop" />
              反复成立。
            </h2>
            <p className="landing-outfits-intro">
              不是靠更多衣服成为更多自己，而是让同一件喜欢的上衣，在工作、城市、周末和放松时刻里，一次次被重新选择。
            </p>

            <div
              className="landing-outfits-caption"
              key={outfitSlides[activeOutfit].id}
            >
              <span>{outfitSlides[activeOutfit].scene}</span>
              <h3>{outfitSlides[activeOutfit].title}</h3>
              <p>{outfitSlides[activeOutfit].description}</p>
            </div>

            <div className="landing-outfits-controls">
              <button
                type="button"
                onClick={showPreviousOutfit}
                aria-label="查看上一套穿搭"
              >
                <ArrowLeft aria-hidden="true" />
              </button>
              <div className="landing-outfits-dots" aria-label="选择穿搭">
                {outfitSlides.map((slide, index) => (
                  <button
                    className={activeOutfit === index ? "is-active" : ""}
                    key={slide.id}
                    type="button"
                    onClick={() => selectOutfit(index)}
                    aria-label={`查看${slide.title}`}
                    aria-current={activeOutfit === index ? "true" : undefined}
                  />
                ))}
              </div>
              <button
                type="button"
                className="landing-outfits-playback"
                onClick={() => setIsOutfitPaused((paused) => !paused)}
                aria-label={
                  prefersReducedMotion
                    ? "减少动态模式下自动播放已关闭"
                    : isOutfitPaused
                      ? "继续自动播放"
                      : "暂停自动播放"
                }
                disabled={prefersReducedMotion}
              >
                {isOutfitPaused || prefersReducedMotion ? (
                  <Play aria-hidden="true" />
                ) : (
                  <Pause aria-hidden="true" />
                )}
              </button>
              <button
                type="button"
                onClick={showNextOutfit}
                aria-label="查看下一套穿搭"
              >
                <ArrowRight aria-hidden="true" />
              </button>
            </div>

            <span className="landing-sr-only" aria-live="polite">
              {outfitAnnouncement}
            </span>
          </div>
        </div>
      </section>

      <section
        className="landing-faq"
        id="faq"
        aria-labelledby="faq-title"
      >
        <div className="landing-shell landing-faq-grid">
          <div>
            <p className="landing-section-label">常见问题</p>
            <h2 id="faq-title" className="landing-display">
              开始之前，
              <br />
              你可能还想知道
            </h2>
          </div>
          <div className="landing-faq-list">
            {faqs.map((item, index) => (
              <details key={item.question}>
                <summary>
                  <span>0{index + 1}</span>
                  <strong>{item.question}</strong>
                  <i aria-hidden="true">＋</i>
                </summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="landing-final-cta">
        <div className="landing-shell landing-final-cta-inner">
          <div>
            <p className="landing-section-label">从今天开始</p>
            <h2 className="landing-display">让时间，成为你最好的购物顾问。</h2>
          </div>
          <Link className="landing-button" href="/app">
            开始一条长期决策
            <ArrowRight aria-hidden="true" />
          </Link>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="landing-shell landing-footer-inner">
          <Brand />
          <p>理性消费 · 长期主义 · 认真选择，长久相处</p>
          <span className="landing-footer-note">视觉方向：长期主义衣橱</span>
        </div>
      </footer>

      {preview && (
        <div
          className="landing-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={preview.alt}
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setPreview(null);
          }}
        >
          <button
            className="landing-lightbox-close"
            type="button"
            onClick={() => setPreview(null)}
            aria-label="关闭预览"
            autoFocus
          >
            <X aria-hidden="true" />
          </button>
          <div className="landing-lightbox-image">
            <Image
              src={preview.src}
              alt={preview.alt}
              fill
              sizes="94vw"
              priority
            />
          </div>
        </div>
      )}
    </main>
  );
}
